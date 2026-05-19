use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
#[cfg(debug_assertions)]
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tao::event_loop::EventLoopProxy;

use crate::review::manager::{ReviewCommand, ReviewManager};
use crate::watcher::UserEvent;

/// Structured interaction actions for E2E testing (debug builds only).
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum InteractAction {
    #[serde(rename = "click")]
    Click { selector: String },
    #[serde(rename = "wait_for")]
    WaitFor { selector: String, timeout_ms: u64 },
    #[serde(rename = "query")]
    Query { selector: String },
    #[serde(rename = "fill")]
    Fill { selector: String, value: String },
}

/// Information about a matched DOM element.
#[cfg(debug_assertions)]
#[derive(Debug, Serialize, Deserialize)]
pub struct ElementInfo {
    pub tag: String,
    pub text: String,
    pub visible: bool,
    pub attributes: HashMap<String, String>,
}

/// Result of an interaction action.
#[cfg(debug_assertions)]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum InteractResult {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "found")]
    Found {
        count: usize,
        elements: Vec<ElementInfo>,
    },
    #[serde(rename = "not_found")]
    NotFound { selector: String },
    #[serde(rename = "timeout")]
    Timeout { selector: String, timeout_ms: u64 },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Message sent over the unix socket from client to daemon.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SocketMessage {
    #[serde(rename = "open")]
    Open { path: String },
    #[cfg(debug_assertions)]
    #[serde(rename = "screenshot")]
    Screenshot,
    #[serde(rename = "info")]
    Info,
    #[cfg(debug_assertions)]
    #[serde(rename = "eval")]
    Eval { js: String },
    #[cfg(debug_assertions)]
    #[serde(rename = "interact")]
    Interact(InteractAction),
    /// Join a review room via an `attn://review/<roomId>#key=...` invite URL.
    ///
    /// The `invite` string is the full invite URI including any `#key=...`
    /// fragment. The fragment is intentionally preserved because the future
    /// crypto layer (issue 2.8 / Phase 6) derives the room key from it.
    /// The fragment never crosses the network — this socket is local to the
    /// machine, and the wry custom-scheme handler delivers the full URL
    /// (fragment included) in-process.
    #[serde(rename = "review_join")]
    ReviewJoin { invite: String },

    /// Share the current path as a review room. CLI agents call this to
    /// host a review without going through the UI. Real handling lives in
    /// `ReviewManager` (issue attn-nnj.2.8); for now the daemon logs and
    /// returns Ok.
    ///
    /// Spec: `data-model.md` §Daemon Socket Commands.
    #[serde(rename = "review_share", rename_all = "camelCase")]
    ReviewShare {
        path: String,
        mode: String,
        #[serde(default)]
        ttl: Option<String>,
    },

    /// Pull pending envelopes for one room (or every active room when
    /// `room_id` is None). Stubbed until issue attn-nnj.2.8.
    ///
    /// Spec: `data-model.md` §Daemon Socket Commands.
    #[serde(rename = "review_pull", rename_all = "camelCase")]
    ReviewPull {
        #[serde(default)]
        room_id: Option<String>,
    },

    /// Stop hosting/participating in one room (or every room when
    /// `room_id` is None). Stubbed until issue attn-nnj.2.8.
    ///
    /// Spec: `data-model.md` §Daemon Socket Commands.
    #[serde(rename = "review_stop", rename_all = "camelCase")]
    ReviewStop {
        #[serde(default)]
        room_id: Option<String>,
    },

    /// List inbound review notifications. Stubbed until issue
    /// attn-nnj.2.8 — real implementation returns a typed inbox payload.
    ///
    /// Spec: `data-model.md` §Daemon Socket Commands.
    #[serde(rename = "review_inbox")]
    ReviewInbox,
}

/// Response sent from daemon back to client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SocketResponse {
    #[serde(rename = "ok")]
    Ok,
    #[cfg(debug_assertions)]
    #[serde(rename = "screenshot")]
    Screenshot { path: String },
    #[serde(rename = "info")]
    Info {
        binary: String,
        pid: u32,
        window_id: Option<i64>,
    },
    #[cfg(debug_assertions)]
    #[serde(rename = "eval")]
    Eval { result: String },
    #[cfg(debug_assertions)]
    #[serde(rename = "interact")]
    Interact(InteractResult),
    #[serde(rename = "error")]
    Error { message: String },
}

/// Runtime directory for daemon state (socket, fingerprint, log, future reviews/).
///
/// Override: `ATTN_HOME` env var, when set to a non-empty path, replaces the
/// default in both debug and release builds. This is the entry point for
/// multi-instance dev (e.g. running an "owner" and "reviewer" daemon side by
/// side for local collab testing).
///
/// Debug: in `/tmp` with a short, deterministic per-binary namespace.
/// This keeps the unix socket path under `SUN_LEN` even when launching from
/// deep app bundle paths.
/// Release: `~/.attn/`.
pub(crate) fn runtime_dir() -> Result<PathBuf> {
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
    // 64-bit FNV-1a over the executable path; short and deterministic.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in path.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Return the socket path.
fn socket_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("attn.sock"))
}

/// Ensure the runtime directory exists.
fn ensure_runtime_dir() -> Result<()> {
    let dir = runtime_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("could not create {}", dir.display()))?;
    }
    Ok(())
}

/// Compute a fingerprint of the current binary (mtime + size).
fn binary_fingerprint() -> Result<String> {
    let exe = std::env::current_exe().context("could not determine executable path")?;
    let meta =
        std::fs::metadata(&exe).with_context(|| format!("could not stat {}", exe.display()))?;
    let mtime = meta
        .modified()
        .context("could not read mtime")?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let size = meta.len();
    Ok(format!("{mtime}:{size}"))
}

/// Path to the stored daemon binary fingerprint.
fn fingerprint_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("attn.fingerprint"))
}

/// Write the current binary's fingerprint to disk.
pub fn write_fingerprint() -> Result<()> {
    ensure_runtime_dir()?;
    let fp = binary_fingerprint()?;
    std::fs::write(fingerprint_path()?, fp).context("could not write fingerprint")?;
    Ok(())
}

/// Check if the running daemon's binary matches the current binary.
/// Returns true if they match (daemon is up-to-date).
fn daemon_binary_matches() -> bool {
    let Ok(stored) = std::fs::read_to_string(fingerprint_path().unwrap_or_default()) else {
        return false;
    };
    let Ok(current) = binary_fingerprint() else {
        return false;
    };
    stored.trim() == current.trim()
}

/// If a stale daemon is running (different binary), kill it and clean up.
/// Returns Ok(true) if a stale daemon was killed, Ok(false) if no action needed.
pub fn replace_stale_daemon() -> Result<bool> {
    let sock = socket_path()?;
    if !sock.exists() {
        return Ok(false);
    }
    if daemon_binary_matches() {
        return Ok(false);
    }
    // Binary changed — get the old daemon's PID and kill it
    match send_info() {
        Ok(info) => {
            eprintln!("attn: binary changed, replacing daemon (pid {})", info.pid);
            let pid = nix::unistd::Pid::from_raw(info.pid as i32);
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM);
            // Wait for socket to disappear
            let deadline = Instant::now() + Duration::from_secs(3);
            while sock.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            // Force cleanup if socket is still there
            if sock.exists() {
                let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
                std::thread::sleep(Duration::from_millis(100));
                let _ = std::fs::remove_file(&sock);
            }
            Ok(true)
        }
        Err(_) => {
            // Can't talk to daemon but socket exists — stale socket
            let _ = std::fs::remove_file(&sock);
            Ok(true)
        }
    }
}

/// Try to connect to an existing daemon and send a file path to open.
/// Returns Ok(true) if we connected and sent successfully (caller should exit).
/// Returns Ok(false) if no daemon is running (caller should become daemon).
pub fn try_send_to_existing(path: &str) -> Result<bool> {
    let msg = SocketMessage::Open {
        path: path.to_string(),
    };
    match send_command(&msg)? {
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

/// Send a screenshot command to the running daemon.
/// Returns the path to the saved screenshot.
#[cfg(debug_assertions)]
pub fn send_screenshot() -> Result<String> {
    match send_command(&SocketMessage::Screenshot)? {
        Some(resp) => match resp {
            SocketResponse::Screenshot { path } => Ok(path),
            SocketResponse::Error { message } => bail!("screenshot failed: {message}"),
            other => bail!("unexpected response: {other:?}"),
        },
        None => bail!("no daemon running"),
    }
}

/// Daemon info returned by `send_info`.
#[allow(dead_code)]
pub struct DaemonInfo {
    pub binary: String,
    pub pid: u32,
    pub window_id: Option<i64>,
}

/// Send an info command to the running daemon.
pub fn send_info() -> Result<DaemonInfo> {
    match send_command(&SocketMessage::Info)? {
        Some(resp) => match resp {
            SocketResponse::Info {
                binary,
                pid,
                window_id,
            } => Ok(DaemonInfo {
                binary,
                pid,
                window_id,
            }),
            SocketResponse::Error { message } => bail!("info failed: {message}"),
            other => bail!("unexpected response: {other:?}"),
        },
        None => bail!("no daemon running"),
    }
}

/// Evaluate JavaScript in the daemon's webview and return the result.
#[cfg(debug_assertions)]
pub fn send_eval(js: &str) -> Result<String> {
    match send_command(&SocketMessage::Eval { js: js.to_string() })? {
        Some(resp) => match resp {
            SocketResponse::Eval { result } => Ok(result),
            SocketResponse::Error { message } => bail!("eval failed: {message}"),
            other => bail!("unexpected response: {other:?}"),
        },
        None => bail!("no daemon running"),
    }
}

/// Send an interaction command to the daemon.
#[cfg(debug_assertions)]
pub fn send_interact(action: InteractAction) -> Result<InteractResult> {
    match send_command(&SocketMessage::Interact(action))? {
        Some(resp) => match resp {
            SocketResponse::Interact(result) => Ok(result),
            SocketResponse::Error { message } => bail!("interact failed: {message}"),
            other => bail!("unexpected response: {other:?}"),
        },
        None => bail!("no daemon running"),
    }
}

/// Send a `ReviewJoin` command to the running daemon.
///
/// Used by future CLI entry points (e.g. a macOS URL handler that re-execs
/// `attn` with the invite URI). Returns Ok(()) if the daemon accepted the
/// invite or an error otherwise. Real join behavior is wired in issue 2.8.
#[allow(dead_code)]
pub fn send_review_join(invite: &str) -> Result<()> {
    let msg = SocketMessage::ReviewJoin {
        invite: invite.to_string(),
    };
    match send_command(&msg)? {
        Some(SocketResponse::Ok) => Ok(()),
        Some(SocketResponse::Error { message }) => bail!("review_join failed: {message}"),
        Some(other) => bail!("unexpected response: {other:?}"),
        None => bail!("no daemon running"),
    }
}

/// Send a command to the daemon and read the response.
/// Returns None if no daemon is running.
fn send_command(msg: &SocketMessage) -> Result<Option<SocketResponse>> {
    let sock = socket_path()?;
    match UnixStream::connect(&sock) {
        Ok(mut stream) => {
            let json = serde_json::to_string(msg).context("failed to serialize socket message")?;
            writeln!(stream, "{json}").context("failed to send message to daemon")?;
            stream
                .shutdown(std::net::Shutdown::Write)
                .context("failed to shutdown write")?;

            // Read response
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .context("failed to read response from daemon")?;
            if line.is_empty() {
                return Ok(Some(SocketResponse::Ok));
            }
            let resp: SocketResponse =
                serde_json::from_str(line.trim()).context("failed to parse daemon response")?;
            Ok(Some(resp))
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::ConnectionRefused
                || e.kind() == std::io::ErrorKind::NotFound
            {
                if sock.exists() {
                    let _ = std::fs::remove_file(&sock);
                }
                Ok(None)
            } else {
                Err(e).context("unexpected error connecting to daemon socket")
            }
        }
    }
}

/// Fork the process. Parent exits, child becomes the daemon.
/// If `no_fork` is true, skip forking (for development).
pub fn maybe_fork(no_fork: bool) -> Result<()> {
    if no_fork {
        return Ok(());
    }

    // AppKit/WebKit startup after raw fork is unreliable on macOS.
    // Re-exec ourselves with --no-fork in a detached child instead.
    #[cfg(target_os = "macos")]
    {
        use std::ffi::OsString;
        use std::process::{Command, Stdio};

        let exe = std::env::current_exe().context("could not determine executable path")?;
        let mut args: Vec<OsString> = std::env::args_os()
            .skip(1)
            .filter(|arg| arg != "--no-fork")
            .collect();
        args.push(OsString::from("--no-fork"));

        let mut cmd = Command::new(exe);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null());

        if let Ok(log_dir) = runtime_dir() {
            let log_path = log_dir.join("attn.log");
            if let Ok(log_file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                cmd.stderr(Stdio::from(log_file));
            } else {
                cmd.stderr(Stdio::null());
            }
        } else {
            cmd.stderr(Stdio::null());
        }

        let _child = cmd.spawn().context("failed to spawn detached child")?;
        std::process::exit(0);
    }

    #[cfg(not(target_os = "macos"))]
    {
        use nix::unistd::{ForkResult, close, dup2, fork, setsid};
        use std::os::unix::io::{AsRawFd, IntoRawFd};

        // Safety: we're single-threaded at this point (before event loop starts)
        match unsafe { fork() }.context("fork failed")? {
            ForkResult::Child => {
                // Become session leader
                setsid().context("setsid failed")?;

                // Redirect stderr to log file for debugging
                if let Some(log_path) = runtime_dir().ok().map(|d| d.join("attn.log"))
                    && let Ok(log_file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log_path)
                {
                    let fd = log_file.into_raw_fd();
                    let _ = dup2(fd, std::io::stderr().as_raw_fd());
                    let _ = close(fd);
                    // Close stdin
                    let _ = close(std::io::stdin().as_raw_fd());
                }

                Ok(())
            }
            ForkResult::Parent { .. } => {
                // Parent process — exit immediately, returning shell control
                std::process::exit(0);
            }
        }
    }
}

/// Forward a `ReviewCommand` received over the unix socket to the running
/// `ReviewManager`. Mirrors `ipc::submit_review_command` — if the manager is
/// absent (store unavailable at startup) the command is logged and dropped,
/// keeping the daemon up even when collab persistence is broken.
fn submit_review_socket_command(
    review_manager: Option<&Arc<ReviewManager>>,
    cmd: ReviewCommand,
) {
    match review_manager {
        Some(manager) => manager.submit(cmd),
        None => eprintln!(
            "attn: socket review command dropped — ReviewManager unavailable: {cmd:?}"
        ),
    }
}

/// Parse a wire-format room id (`String`) into the typed `RoomId` newtype.
/// The constructor on `RoomId` is crate-private, so we route through serde —
/// same trick used in tests and stub helpers.
fn parse_room_id(raw: String) -> crate::review::ids::RoomId {
    serde_json::from_value::<crate::review::ids::RoomId>(serde_json::Value::String(raw))
        .expect("RoomId is just a string newtype")
}

/// Log a `ReviewJoin` invite for the stub join handler.
///
/// Shared by both the socket-message dispatch in `handle_client` and the
/// in-process custom-protocol handler in `main.rs`, so the routing surface
/// behaves identically regardless of whether the invite arrives via the
/// `attn://review/...` URL scheme (clicked in the OS) or a future
/// `SocketMessage::ReviewJoin` from another process.
///
/// Real `ReviewManager` wiring lands in issue 2.8.
pub fn log_review_join_intent(invite: &str) {
    eprintln!("attn: review_join invite received (stub, manager wiring pending): {invite}");
}

/// Dispatch a `ReviewJoin` from the in-process custom-protocol handler.
///
/// Equivalent to receiving a `SocketMessage::ReviewJoin` over the unix
/// socket, but avoids a socket round-trip when the handler is already
/// running inside the daemon process. The `invite` must be the full
/// invite URI including any `#key=...` fragment.
///
/// `review_manager` is forwarded to `ReviewManager::submit` so the same stub
/// `ReviewUpdate` flows back into the event loop regardless of whether the
/// invite arrived via custom protocol, webview IPC, or unix socket.
pub fn dispatch_review_join(invite: &str, review_manager: Option<&Arc<ReviewManager>>) {
    log_review_join_intent(invite);
    submit_review_socket_command(
        review_manager,
        ReviewCommand::Join {
            invite: invite.to_string(),
        },
    );
}

/// Start listening on the unix socket. Spawns a thread that accepts connections
/// and sends events through the event loop proxy.
///
/// `review_manager` is forwarded into the socket-side `Review*` handlers so
/// CLI agents (e.g. `attn review share foo.md`) reach the same dispatch path
/// the webview IPC handlers use. `None` is acceptable — those handlers log
/// and continue rather than panic.
pub fn start_listener(
    proxy: EventLoopProxy<UserEvent>,
    review_manager: Option<Arc<ReviewManager>>,
) -> Result<SocketCleanup> {
    ensure_runtime_dir()?;
    let sock = socket_path()?;

    // Remove stale socket
    if sock.exists() {
        std::fs::remove_file(&sock).context("could not remove stale socket")?;
    }

    let listener = UnixListener::bind(&sock)
        .with_context(|| format!("could not bind socket at {}", sock.display()))?;

    let sock_path = Arc::new(sock);
    let cleanup_path = Arc::clone(&sock_path);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let proxy = proxy.clone();
                    let manager = review_manager.clone();
                    handle_client(stream, &proxy, manager.as_ref());
                }
                Err(e) => {
                    eprintln!("attn: socket accept error: {e}");
                    break;
                }
            }
        }
    });

    Ok(SocketCleanup { path: cleanup_path })
}

fn handle_client(
    mut stream: UnixStream,
    proxy: &EventLoopProxy<UserEvent>,
    review_manager: Option<&Arc<ReviewManager>>,
) {
    let reader_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("attn: failed to clone stream: {e}");
            return;
        }
    };
    let reader = BufReader::new(reader_stream);

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<SocketMessage>(&line) {
            Ok(SocketMessage::Open { path }) => {
                let path = PathBuf::from(path);
                let _ = proxy.send_event(UserEvent::SwitchProject(path));
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            #[cfg(debug_assertions)]
            Ok(SocketMessage::Screenshot) => {
                let (tx, rx) = std::sync::mpsc::channel();
                let _ = proxy.send_event(UserEvent::Screenshot(tx));
                match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(path) => {
                        let resp = SocketResponse::Screenshot { path };
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::to_string(&resp).unwrap_or_default()
                        );
                    }
                    Err(_) => {
                        let resp = SocketResponse::Error {
                            message: "screenshot timed out".to_string(),
                        };
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::to_string(&resp).unwrap_or_default()
                        );
                    }
                }
            }
            Ok(SocketMessage::Info) => {
                let (tx, rx) = std::sync::mpsc::channel();
                let _ = proxy.send_event(UserEvent::Info(tx));
                match rx.recv_timeout(std::time::Duration::from_secs(2)) {
                    Ok(info_json) => {
                        // info_json is already a serialized SocketResponse::Info
                        let _ = writeln!(stream, "{info_json}");
                    }
                    Err(_) => {
                        let resp = SocketResponse::Error {
                            message: "info timed out".to_string(),
                        };
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::to_string(&resp).unwrap_or_default()
                        );
                    }
                }
            }
            #[cfg(debug_assertions)]
            Ok(SocketMessage::Eval { js }) => {
                let (tx, rx) = std::sync::mpsc::channel();
                let _ = proxy.send_event(UserEvent::Eval(js, tx));
                match rx.recv_timeout(std::time::Duration::from_secs(10)) {
                    Ok(result) => {
                        let resp = SocketResponse::Eval { result };
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::to_string(&resp).unwrap_or_default()
                        );
                    }
                    Err(_) => {
                        let resp = SocketResponse::Error {
                            message: "eval timed out".to_string(),
                        };
                        let _ = writeln!(
                            stream,
                            "{}",
                            serde_json::to_string(&resp).unwrap_or_default()
                        );
                    }
                }
            }
            #[cfg(debug_assertions)]
            Ok(SocketMessage::Interact(action)) => {
                let result = execute_interact(&action, proxy);
                let resp = SocketResponse::Interact(result);
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            Ok(SocketMessage::ReviewJoin { invite }) => {
                // Both: log via the shared intent helper (keeps custom-protocol
                // + socket routes observably equivalent) and dispatch into the
                // ReviewManager so the scaffold's stub Update flows through.
                log_review_join_intent(&invite);
                submit_review_socket_command(
                    review_manager,
                    ReviewCommand::Join { invite },
                );
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            // Review socket commands routed through `ReviewManager` (issue
            // attn-nnj.2.8). The manager logs each command, emits a stub
            // `ReviewUpdate` back into the event loop, and we Ok the caller.
            // Real handler bodies land in later issues.
            Ok(SocketMessage::ReviewShare { path, mode, ttl }) => {
                submit_review_socket_command(
                    review_manager,
                    ReviewCommand::Share {
                        path: PathBuf::from(path),
                        mode,
                        ttl,
                    },
                );
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            Ok(SocketMessage::ReviewPull { room_id }) => {
                submit_review_socket_command(
                    review_manager,
                    ReviewCommand::Pull {
                        room_id: room_id.map(parse_room_id),
                    },
                );
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            Ok(SocketMessage::ReviewStop { room_id }) => {
                submit_review_socket_command(
                    review_manager,
                    ReviewCommand::Stop {
                        room_id: room_id.map(parse_room_id),
                    },
                );
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            Ok(SocketMessage::ReviewInbox) => {
                submit_review_socket_command(review_manager, ReviewCommand::Inbox);
                let resp = SocketResponse::Ok;
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
            Err(e) => {
                eprintln!("attn: invalid socket message: {e}");
                let resp = SocketResponse::Error {
                    message: format!("invalid message: {e}"),
                };
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
            }
        }
    }
}

/// Generate JavaScript for an interaction action.
/// All scripts are synchronous (no Promises) and return a JSON string.
#[cfg(debug_assertions)]
fn interaction_js(action: &InteractAction) -> String {
    // The __resolve helper finds elements by CSS selector or `text=` prefix.
    let resolve_fn = r#"
function __resolve(sel) {
    if (sel.startsWith('text=')) {
        var target = sel.slice(5);
        var all = document.querySelectorAll('button, a, [role=button], [data-sidebar], span, p, h1, h2, h3, h4, h5, h6, li, td, th, label, div');
        var matched = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].textContent && all[i].textContent.trim() === target) matched.push(all[i]);
        }
        return matched;
    }
    return Array.from(document.querySelectorAll(sel));
}
"#;

    match action {
        InteractAction::Click { selector } => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            format!(
                r#"(function() {{
{resolve_fn}
var els = __resolve({sel_json});
if (els.length === 0) return JSON.stringify({{status:'not_found',selector:{sel_json}}});
els[0].click();
return JSON.stringify({{status:'ok'}});
}})()"#,
            )
        }
        InteractAction::Query { selector } => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            format!(
                r#"(function() {{
{resolve_fn}
var els = __resolve({sel_json});
if (els.length === 0) return JSON.stringify({{status:'not_found',selector:{sel_json}}});
var elements = [];
for (var i = 0; i < els.length; i++) {{
    var el = els[i];
    var attrs = {{}};
    for (var j = 0; j < el.attributes.length; j++) {{
        attrs[el.attributes[j].name] = el.attributes[j].value;
    }}
    var rect = el.getBoundingClientRect();
    elements.push({{
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim(),
        visible: rect.width > 0 && rect.height > 0,
        attributes: attrs
    }});
}}
return JSON.stringify({{status:'found',count:elements.length,elements:elements}});
}})()"#,
            )
        }
        InteractAction::Fill { selector, value } => {
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            let val_json = serde_json::to_string(value).unwrap_or_default();
            format!(
                r#"(function() {{
{resolve_fn}
var els = __resolve({sel_json});
if (els.length === 0) return JSON.stringify({{status:'not_found',selector:{sel_json}}});
var el = els[0];
el.value = {val_json};
el.dispatchEvent(new Event('input', {{bubbles:true}}));
el.dispatchEvent(new Event('change', {{bubbles:true}}));
return JSON.stringify({{status:'ok'}});
}})()"#,
            )
        }
        InteractAction::WaitFor { selector, .. } => {
            // For wait_for, we just check if the element exists (used by the polling loop)
            let sel_json = serde_json::to_string(selector).unwrap_or_default();
            format!(
                r#"(function() {{
{resolve_fn}
var els = __resolve({sel_json});
if (els.length > 0) return JSON.stringify({{status:'ok'}});
return JSON.stringify({{status:'not_found',selector:{sel_json}}});
}})()"#,
            )
        }
    }
}

/// Parse a JSON string returned from interaction JS into an InteractResult.
#[cfg(debug_assertions)]
fn parse_interact_result(raw: &str) -> InteractResult {
    // The JS returns a JSON-encoded string, which wry wraps in quotes.
    // Try parsing directly first, then try unescaping.
    if let Ok(result) = serde_json::from_str::<InteractResult>(raw) {
        return result;
    }
    // wry returns the result as a JSON string (double-encoded)
    if let Ok(inner) = serde_json::from_str::<String>(raw)
        && let Ok(result) = serde_json::from_str::<InteractResult>(&inner)
    {
        return result;
    }
    InteractResult::Error {
        message: format!("failed to parse interact result: {raw}"),
    }
}

/// Execute an interact action via eval, handling WaitFor polling on the socket handler thread.
#[cfg(debug_assertions)]
fn execute_interact(action: &InteractAction, proxy: &EventLoopProxy<UserEvent>) -> InteractResult {
    match action {
        InteractAction::WaitFor {
            selector,
            timeout_ms,
        } => {
            let check_js = interaction_js(action);
            let deadline = Instant::now() + Duration::from_millis(*timeout_ms);
            loop {
                let (tx, rx) = std::sync::mpsc::channel();
                let _ = proxy.send_event(UserEvent::Eval(check_js.clone(), tx));
                if let Result::Ok(result) = rx.recv_timeout(Duration::from_secs(2)) {
                    let parsed = parse_interact_result(&result);
                    if matches!(parsed, InteractResult::Ok) {
                        return InteractResult::Ok;
                    }
                }
                if Instant::now() >= deadline {
                    return InteractResult::Timeout {
                        selector: selector.clone(),
                        timeout_ms: *timeout_ms,
                    };
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        _ => {
            let js = interaction_js(action);
            let (tx, rx) = std::sync::mpsc::channel();
            let _ = proxy.send_event(UserEvent::Eval(js, tx));
            match rx.recv_timeout(Duration::from_secs(10)) {
                Result::Ok(result) => parse_interact_result(&result),
                Err(_) => InteractResult::Error {
                    message: "eval timed out".to_string(),
                },
            }
        }
    }
}

/// Cleans up the socket file when dropped.
pub struct SocketCleanup {
    path: Arc<PathBuf>,
}

impl SocketCleanup {
    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(self.path.as_ref());
    }
}

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::manager::{ReviewUpdate, UpdateSink};
    use crate::review::store::ReviewStore;
    use crate::review::working_copy::WorkingCopyService;
    use std::sync::Mutex;
    use std::sync::mpsc;
    use tempfile::TempDir;

    fn make_test_manager() -> (Arc<ReviewManager>, mpsc::Receiver<ReviewUpdate>, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = Mutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("test sink mutex").send(update);
        });
        let mgr = Arc::new(ReviewManager::new(store, working_copy, sink));
        (mgr, rx, tmp)
    }

    #[test]
    fn submit_review_socket_command_routes_to_manager() {
        // The daemon-socket side mirrors the webview-side IPC dispatch:
        // each Review* SocketMessage variant lowers to a ReviewCommand and
        // submit_review_socket_command hands it to the manager.
        let (manager, rx, _tmp) = make_test_manager();
        submit_review_socket_command(
            Some(&manager),
            ReviewCommand::Share {
                path: PathBuf::from("/tmp/plan.md"),
                mode: "async".to_string(),
                ttl: None,
            },
        );
        let update = rx.try_recv().expect("manager emitted one update");
        assert!(
            matches!(update, ReviewUpdate::RoomStatusChanged { .. }),
            "expected RoomStatusChanged stub from Share, got {update:?}"
        );
    }

    #[test]
    fn submit_review_socket_command_no_op_when_manager_missing() {
        // Defensive: a daemon that couldn't open the review store at startup
        // hands `None` into `start_listener`. The socket handler must drop
        // the command rather than panic.
        submit_review_socket_command(
            None,
            ReviewCommand::Inbox,
        );
        // Pass = no panic.
    }

    #[test]
    fn parse_room_id_round_trips_through_serde() {
        // We construct typed RoomIds from the wire format on the socket-side;
        // pin that the helper preserves the string exactly.
        let id = parse_room_id("room-abc".to_string());
        assert_eq!(id.as_str(), "room-abc");
    }
}
