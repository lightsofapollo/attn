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
    BootstrapConfig, BootstrapError, Bootstrapper, DeviceIdentity, IDENTITY_FILENAME,
    load_identity_from, load_or_create_identity_in,
};
use crate::review::store::ReviewStore;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `attn review …` argument tree.
#[derive(Args, Debug)]
pub struct ReviewArgs {
    /// Target a specific attn daemon runtime. Equivalent to setting
    /// `ATTN_HOME`, but easier to use when driving multiple windows.
    #[arg(long, global = true, value_name = "DIR")]
    pub attn_home: Option<PathBuf>,

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

    /// Share a file or directory for review via the running attn daemon.
    ///
    /// A directory publishes a snapshot per `*.md` under it (folder-share);
    /// files added to the directory later are picked up automatically. The
    /// daemon shares as its own device identity, and the app window shows the
    /// invite link.
    Share {
        /// File or directory to share.
        path: String,
        /// Room mode: `live`, `async`, or `hybrid`.
        #[arg(long, default_value = "live")]
        mode: String,
        /// TTL for async/hybrid rooms (e.g. `24h`, `7d`).
        #[arg(long, value_name = "TTL")]
        ttl: Option<String>,
    },

    /// Print suggestion verdicts derived from persisted review events across
    /// every local room. JSON has the stable shape
    /// `{"rooms":{"<room_id>":{"suggestions":{"<suggestion_id>":{"status":"pending|accepted|rejected","resulting_hash":"<hash>"}}}}}`.
    /// `resulting_hash` is present only for accepted suggestions.
    Verdicts {
        /// Emit the documented machine-readable JSON report.
        #[arg(long)]
        json: bool,
        /// Include suggestions from every creator, rather than only the
        /// calling identity's suggestions.
        #[arg(long)]
        all: bool,
        /// Scope to this registered agent identity instead of the daemon's
        /// identity. Ignored for filtering with `--all`, but still validated.
        #[arg(long, value_name = "NAME")]
        as_agent: Option<String>,
    },

    /// Run a **headless, long-lived** review participant — no window, no
    /// webview. The keystone for cross-topology testing (attn-8zd): a GUI-less
    /// peer that joins a room, *holds* the connection (WebRTC mesh + relay WS),
    /// applies inbound events/collab, and persists to the review store, so a
    /// harness can run N peers in Docker containers / network namespaces and
    /// assert convergence — something the native daemon (which needs a display)
    /// can't do in headless CI.
    ///
    /// Driven over **stdin** as one JSON command per line; emits every
    /// `ReviewUpdate` as one JSON line on **stdout** (prefixed `@update `) so a
    /// test can observe convergence. Runs until stdin EOF or `{"cmd":"quit"}`.
    ///
    /// Identity + store come from `ATTN_HOME`; relay from `ATTN_RELAY_URL`
    /// (same resolution as the daemon). Each container sets its own `ATTN_HOME`
    /// so peers stay isolated.
    ///
    /// Stdin commands (one JSON object per line):
    /// ```text
    /// {"cmd":"share","path":"/work/doc.md","mode":"live"}
    /// {"cmd":"join","invite":"attn://review/<roomId>#key=..."}
    /// {"cmd":"comment","body":"text"}
    /// {"cmd":"collab","payload":"{...opaque...}"}
    /// {"cmd":"pull"}
    /// {"cmd":"quit"}
    /// ```
    Agent {
        /// Optionally share this path on startup (owner role) instead of
        /// waiting for a `join` command. Mutually informative with `--mode`.
        #[arg(long, value_name = "PATH")]
        share: Option<String>,
        /// Room mode for `--share`: `live`, `async`, or `hybrid`.
        #[arg(long, default_value = "live")]
        mode: String,
        /// Override the relay URL (default: env `ATTN_RELAY_URL`).
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
    let ReviewArgs { attn_home, command } = args;
    if let Some(home) = attn_home {
        set_attn_home_for_review(&home)?;
    }

    match command {
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
        ReviewSubcommand::Share { path, mode, ttl } => {
            run_share_via_daemon(&path, &mode, ttl.as_deref())
        }
        ReviewSubcommand::Verdicts {
            json,
            all,
            as_agent,
        } => run_verdicts(json, all, as_agent.as_deref()),
        ReviewSubcommand::Agent {
            share,
            mode,
            relay_url,
        } => run_agent(share.as_deref(), &mode, relay_url.as_deref()),
    }
}

fn run_verdicts(json: bool, all: bool, as_agent: Option<&str>) -> Result<()> {
    if !json {
        bail!("verdicts currently requires --json");
    }
    let base = runtime_dir().context("resolve runtime_dir for verdict identity")?;
    let identity = load_verdict_identity(&base, as_agent)?;
    let report = crate::daemon::send_review_verdicts(identity.typed_participant_id(), all)
        .context("query persisted review verdicts from the running daemon")?;
    println!("{}", verdicts_json(&report)?);
    Ok(())
}

fn load_verdict_identity(base: &Path, as_agent: Option<&str>) -> Result<DeviceIdentity> {
    match as_agent {
        Some(name) => load_agent_in(base, name).with_context(|| {
            format!("load agent {name:?} — run `attn review register-agent {name}` first")
        }),
        None => load_identity_from(base)
            .context("load daemon identity")?
            .context("no daemon identity exists yet; share or join a review room first"),
    }
}

fn verdicts_json(report: &crate::review::store::VerdictsReport) -> Result<String> {
    serde_json::to_string(report).context("serialize verdict report")
}

fn set_attn_home_for_review(home: &Path) -> Result<()> {
    let home = normalize_attn_home(home)?;
    // SAFETY: `attn review ...` handles this option before starting any local
    // worker threads. The value is then read synchronously by the daemon/store
    // path helpers to choose the target socket namespace.
    unsafe {
        std::env::set_var("ATTN_HOME", home);
    }
    Ok(())
}

fn normalize_attn_home(home: &Path) -> Result<PathBuf> {
    if home.as_os_str().is_empty() {
        bail!("--attn-home requires a non-empty directory");
    }
    if home.is_absolute() {
        Ok(home.to_path_buf())
    } else {
        Ok(std::env::current_dir()
            .context("resolve current directory for --attn-home")?
            .join(home))
    }
}

/// Hand a file/directory to the running daemon to share for review. We
/// canonicalize to an absolute path so it matches the daemon's fs-watcher
/// paths (folder-share republishes newly-added files by absolute-path prefix).
fn run_share_via_daemon(path: &str, mode: &str, ttl: Option<&str>) -> Result<()> {
    let abs =
        std::fs::canonicalize(path).with_context(|| format!("resolve share path {path:?}"))?;
    let abs = abs.to_string_lossy().to_string();
    crate::daemon::send_review_share(&abs, mode, ttl).map_err(|e| {
        anyhow::anyhow!(
            "could not reach a running attn daemon to share ({e}).\n\
             Open attn first, then run `attn review share <path>`."
        )
    })?;
    println!("share request sent to the running attn daemon");
    println!("  path: {abs}");
    println!("  (the app window shows the invite link)");
    Ok(())
}

/// Run a headless, long-lived review participant. Delegates to the library
/// (`crate::review::agent`) so the slim `src/bin/attn-agent.rs` binary shares
/// one implementation without linking the GUI stack. See
/// `ReviewSubcommand::Agent` for the stdin/stdout protocol.
fn run_agent(share: Option<&str>, mode: &str, relay_url_override: Option<&str>) -> Result<()> {
    crate::review::agent::run(share, mode, relay_url_override)
}

/// Validate an invite client-side before shipping it to the daemon.
///
/// The daemon-routed join is fire-and-forget over the unix socket: the
/// daemon parses the invite asynchronously and a malformed one fails
/// *silently* from the CLI's perspective — `attn review join <garbage>`
/// used to print "join request sent" and exit 0 (e.g. when a user pasted
/// the ShareDialog's full `npx attnmd review join 'attn://…'` one-liner as
/// the invite). Reuse the same `parse_invite` the daemon runs so the CLI
/// rejects exactly what the daemon would.
fn validate_invite_for_join(invite: &str) -> Result<()> {
    crate::review::bootstrap::parse_invite(invite).map_err(|e| {
        anyhow::anyhow!(
            "invalid review invite ({e}).\n\
             Expected an invite URL like attn://review/<roomId>#key=<secret> — \
             copy the link from the owner's Share dialog."
        )
    })?;
    Ok(())
}

/// Hand the invite to the running attn daemon so it joins as its OWN device
/// identity (the same device the app window presents). This keeps the CLI join
/// consistent with the daemon — a no-`--as-agent` join shows up in the app.
///
/// If no daemon is running, start attn on the current directory, wait for its
/// socket, then deliver the invite. That keeps the invite one-liner useful for
/// first-time reviewers instead of requiring a separate "open attn" step.
fn run_join_via_daemon(invite: &str) -> Result<()> {
    validate_invite_for_join(invite)?;
    crate::daemon::replace_stale_daemon().context("check running attn daemon")?;
    match crate::daemon::send_review_join(invite) {
        Ok(()) => {
            println!("join request sent to the running attn daemon");
            println!("  invite: {invite}");
            return Ok(());
        }
        Err(_err) if crate::daemon::send_info().is_err() => {
            start_app_for_join()?;
            wait_for_daemon(Duration::from_secs(8))?;
            crate::daemon::send_review_join(invite).map_err(|join_err| {
                anyhow::anyhow!(
                    "started attn, but could not send the review invite ({join_err}).\n\
                     Invite: {invite}"
                )
            })?;
        }
        Err(err) => {
            return Err(anyhow::anyhow!(
                "could not send the review invite to the running attn daemon ({err})."
            ));
        }
    }
    println!("join request sent to the running attn daemon");
    println!("  invite: {invite}");
    Ok(())
}

fn start_app_for_join() -> Result<()> {
    let exe = std::env::current_exe().context("resolve current attn binary")?;
    let cwd = std::env::current_dir().context("resolve current directory for review join")?;
    Command::new(&exe)
        .arg(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("start attn from {}", exe.display()))?;
    Ok(())
}

fn wait_for_daemon(timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if crate::daemon::send_info().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    bail!("started attn, but the daemon did not become ready within {timeout:?}");
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
    let agent_identity = load_or_prompt_register_agent(&base, name)?;

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

fn load_or_prompt_register_agent(base: &std::path::Path, name: &str) -> Result<DeviceIdentity> {
    match load_agent_in(base, name) {
        Ok(identity) => return Ok(identity),
        Err(load_err) => {
            if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                return Err(anyhow::anyhow!(load_err).context(format!(
                    "load agent {name:?} — run `attn review register-agent {name}` first"
                )));
            }
            eprintln!("attn: agent {name:?} is not registered.");
            print!("Create reviewer identity {name:?} now? [Y/n] ");
            io::stdout().flush().context("flush prompt")?;
            let mut answer = String::new();
            io::stdin()
                .read_line(&mut answer)
                .context("read register-agent prompt")?;
            let answer = answer.trim().to_ascii_lowercase();
            if answer == "n" || answer == "no" {
                return Err(anyhow::anyhow!(
                    "agent {name:?} is not registered; run `attn review register-agent {name}` first"
                ));
            }
        }
    }

    let identity =
        register_agent_in(base, name).with_context(|| format!("register agent {name:?}"))?;
    eprintln!("attn: registered agent {name:?}");
    Ok(identity)
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
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: TestCommand,
    }

    #[derive(Subcommand)]
    enum TestCommand {
        Review(ReviewArgs),
    }

    #[test]
    fn verdicts_cli_parses_json_all_and_as_agent() {
        let parsed = TestCli::try_parse_from([
            "attn",
            "review",
            "verdicts",
            "--json",
            "--all",
            "--as-agent",
            "rufus",
        ])
        .expect("parse verdicts CLI");
        match parsed.command {
            TestCommand::Review(ReviewArgs {
                command:
                    ReviewSubcommand::Verdicts {
                        json,
                        all,
                        as_agent,
                    },
                ..
            }) => {
                assert!(json);
                assert!(all);
                assert_eq!(as_agent.as_deref(), Some("rufus"));
            }
            _ => panic!("expected review verdicts"),
        }
    }

    #[test]
    fn verdicts_json_output_is_exact_and_omits_absent_hash() {
        use crate::review::store::{
            RoomVerdicts, SuggestionVerdict, SuggestionVerdictStatus, VerdictsReport,
        };
        let report = VerdictsReport {
            rooms: [(
                "room-a".to_string(),
                RoomVerdicts {
                    suggestions: [
                        (
                            "accepted".to_string(),
                            SuggestionVerdict {
                                status: SuggestionVerdictStatus::Accepted,
                                resulting_hash: Some("hash-exact".to_string()),
                            },
                        ),
                        (
                            "pending".to_string(),
                            SuggestionVerdict {
                                status: SuggestionVerdictStatus::Pending,
                                resulting_hash: None,
                            },
                        ),
                    ]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            verdicts_json(&report).expect("serialize"),
            r#"{"rooms":{"room-a":{"suggestions":{"accepted":{"status":"accepted","resulting_hash":"hash-exact"},"pending":{"status":"pending"}}}}}"#
        );
    }

    #[test]
    fn verdicts_missing_daemon_identity_does_not_create_one() {
        let temp = tempfile::tempdir().expect("tempdir");
        let error = load_verdict_identity(temp.path(), None).expect_err("identity must be absent");
        assert!(error.to_string().contains("no daemon identity exists yet"));
        assert!(!temp.path().join(IDENTITY_FILENAME).exists());
    }

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
    fn daemon_join_rejects_garbage_invites_before_sending() {
        // A non-invite (here: the ShareDialog's full npx one-liner pasted as
        // the invite) must fail loudly client-side instead of being shipped
        // to the daemon, which parses it asynchronously and fails silently.
        for garbage in [
            "npx attnmd review join 'attn://review/abc#key=AAAA'",
            "not-an-invite",
            "",
            "attn://wrong/abc#key=AAAA",
        ] {
            let err = validate_invite_for_join(garbage)
                .expect_err(&format!("garbage invite must be rejected: {garbage:?}"));
            let msg = format!("{err:#}");
            assert!(
                msg.contains("attn://review/"),
                "error should show the expected invite shape, got: {msg}"
            );
        }
    }

    #[test]
    fn daemon_join_accepts_a_well_formed_invite() {
        // Build a real invite the same way the owner's Share path does, so
        // this stays in lockstep with `parse_invite`.
        let secret = [0x5Cu8; 32];
        let room_id = crate::review::crypto::kdf::derive_room_id(&secret);
        let invite = crate::review::bootstrap::build_invite_url(&room_id, &secret);
        validate_invite_for_join(&invite).expect("well-formed invite must validate");
    }

    #[test]
    fn attn_home_target_rejects_empty_path() {
        let err = normalize_attn_home(Path::new("")).expect_err("empty path should fail");
        assert!(err.to_string().contains("--attn-home"));
    }

    #[test]
    fn attn_home_target_normalizes_relative_path() {
        let cwd = std::env::current_dir().expect("cwd");
        let normalized = normalize_attn_home(Path::new("target/reviewer")).expect("normalize");
        assert_eq!(normalized, cwd.join("target/reviewer"));
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
