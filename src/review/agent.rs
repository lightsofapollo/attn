//! Headless, long-lived review participant (attn-8zd).
//!
//! The keystone for cross-topology testing: a GUI-less peer that joins a room,
//! *holds* the connection (WebRTC mesh + relay WS), applies inbound
//! events/collab, and persists to the review store — so a harness can run N
//! peers in Docker containers / network namespaces and assert convergence,
//! which the native daemon (it needs a display) can't do headlessly.
//!
//! This module lives in the **library** and references only `crate::review::*`
//! and `crate::daemon::runtime_dir`, so the slim `src/bin/attn-agent.rs` binary
//! that wraps it does **not** link `wry`/`webkit2gtk`. The full `attn` binary
//! reaches the same logic via `attn review agent` (see `src/cli_review.rs`).
//!
//! ## Protocol
//!
//! Driven over **stdin**, one JSON command per line (or, when
//! `ATTN_AGENT_CMD_FILE` is set, by polling that file for appended lines — the
//! reliable control channel for Docker Desktop, where stdin/FIFO drop writes).
//! Emits two kinds of lines on **stdout** (line-buffered, flushed):
//!   - `@update <json>` — one serialized [`ReviewUpdate`] per line.
//!   - `@agent <msg>`   — control/diagnostic lines (`ready`, `stopped`, errors).
//!
//! Stdin commands:
//! ```text
//! {"cmd":"share","path":"/work/doc.md","mode":"live"}
//! {"cmd":"join","invite":"attn://review/<roomId>#key=..."}
//! {"cmd":"comment","body":"text"}
//! {"cmd":"collab","payload":"{...opaque...}"}
//! {"cmd":"pull"}
//! {"cmd":"quit"}
//! ```
//! Runs until stdin EOF or `quit`. Identity + store come from `ATTN_HOME`;
//! relay from the `relay_url` arg, else `ATTN_RELAY_URL`.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result, bail};

use crate::review::ids::RoomId;
use crate::review::manager::{ReviewCommand, ReviewManager, ReviewUpdate, UpdateSink};
use crate::review::model::{Anchor, PositionAnchor};
use crate::review::store::ReviewStore;
use crate::review::transport::inbound::VerifyingKeyCache;
use crate::review::working_copy::WorkingCopyService;

/// Default relay when none is passed and `ATTN_RELAY_URL` is unset. Matches
/// the dev relay so a local `wrangler dev` works with no extra setup.
const DEFAULT_RELAY_URL: &str = "http://127.0.0.1:8787";

/// Resolve the relay URL: explicit arg → `ATTN_RELAY_URL` → baked default →
/// dev default.
fn resolve_relay_url(relay_url: Option<&str>) -> Result<String> {
    let url = relay_url
        .map(str::to_string)
        .or_else(|| {
            std::env::var("ATTN_RELAY_URL")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(|| option_env!("ATTN_DEFAULT_RELAY_URL").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_RELAY_URL.to_string());
    if url.is_empty() {
        bail!("relay url is empty; pass a relay url or set ATTN_RELAY_URL");
    }
    Ok(url)
}

/// Run the headless agent loop until stdin EOF or a `quit` command.
pub fn run(share: Option<&str>, mode: &str, relay_url: Option<&str>) -> Result<()> {
    let relay_url = resolve_relay_url(relay_url)?;

    let store = Arc::new(ReviewStore::open().context("open review store for agent")?);
    let working_copy = Arc::new(WorkingCopyService::new());

    // Latest room id learned from updates, so comment/collab can target the
    // live room without the harness threading the id through.
    let current_room: Arc<StdMutex<Option<RoomId>>> = Arc::new(StdMutex::new(None));
    let sink_room = Arc::clone(&current_room);

    // Serialize stdout writes between the sink (manager threads) and the
    // control-line emitter on the main thread.
    let stdout_lock = Arc::new(StdMutex::new(()));
    let sink_stdout = Arc::clone(&stdout_lock);
    let sink: UpdateSink = Arc::new(move |update: ReviewUpdate| {
        if let Some(room) = room_id_of(&update) {
            *sink_room.lock().expect("room mutex") = Some(room);
        }
        let line = serde_json::to_string(&update).unwrap_or_else(|_| "{}".to_string());
        let _guard = sink_stdout.lock().expect("stdout mutex");
        println!("@update {line}");
        let _ = std::io::stdout().flush();
    });

    let cache: VerifyingKeyCache = Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let manager = Arc::new(
        ReviewManager::new(store, working_copy, sink)
            .with_bootstrap(relay_url.clone(), None, cache)
            .context("attach bootstrap to agent manager")?,
    );

    emit(&stdout_lock, &format!("ready relay={relay_url}"));

    if let Some(path) = share {
        match std::fs::canonicalize(path) {
            Ok(abs) => manager.submit(ReviewCommand::Share {
                path: abs,
                selected_paths: Vec::new(),
                primary_path: None,
                mode: mode.to_string(),
                ttl: Some("24h".to_string()),
            }),
            Err(e) => emit(&stdout_lock, &format!("error share-path: {e}")),
        }
    }

    // Process one JSON command line. Returns `true` to stop the agent.
    let handle_line = |line: &str| -> bool {
        let line = line.trim();
        if line.is_empty() {
            return false;
        }
        let cmd: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                emit(&stdout_lock, &format!("error bad-json: {e}"));
                return false;
            }
        };
        match cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("") {
            "quit" => return true,
            "share" => {
                let path = cmd.get("path").and_then(|v| v.as_str()).unwrap_or_default();
                let m = cmd.get("mode").and_then(|v| v.as_str()).unwrap_or(mode);
                match std::fs::canonicalize(path) {
                    Ok(abs) => manager.submit(ReviewCommand::Share {
                        path: abs,
                        selected_paths: Vec::new(),
                        primary_path: None,
                        mode: m.to_string(),
                        ttl: Some("24h".to_string()),
                    }),
                    Err(e) => emit(&stdout_lock, &format!("error share-path: {e}")),
                }
            }
            "join" => {
                let invite = cmd
                    .get("invite")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if invite.is_empty() {
                    emit(&stdout_lock, "error join: missing invite");
                } else {
                    manager.submit(ReviewCommand::Join {
                        invite: invite.to_string(),
                    });
                }
            }
            "comment" => {
                let body = cmd.get("body").and_then(|v| v.as_str()).unwrap_or_default();
                // Bind to a `let` so the MutexGuard temporary drops HERE, before
                // `submit`. A `match current_room.lock()...` scrutinee would hold
                // the guard across the whole arm — and `submit` runs synchronously
                // on this thread down into the update sink, which re-locks the
                // same `current_room` mutex (sink_room) → re-entrant deadlock.
                let room = current_room.lock().expect("room mutex").clone();
                match room {
                    Some(room_id) => manager.submit(ReviewCommand::CreateComment {
                        room_id,
                        anchor: placeholder_anchor(),
                        body: body.to_string(),
                        parent_thread_id: None,
                    }),
                    None => emit(&stdout_lock, "error comment: no active room"),
                }
            }
            "collab" => {
                let payload = cmd
                    .get("payload")
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_default();
                // See the `comment` arm: release the room lock before `submit` to
                // avoid the re-entrant deadlock via the update sink.
                let room = current_room.lock().expect("room mutex").clone();
                match room {
                    Some(room_id) => manager.submit(ReviewCommand::SendCollab { room_id, payload }),
                    None => emit(&stdout_lock, "error collab: no active room"),
                }
            }
            "pull" => manager.submit(ReviewCommand::Pull { room_id: None }),
            other => emit(&stdout_lock, &format!("error unknown-cmd: {other}")),
        }
        false
    };

    // Control channel. Default is stdin (one JSON command per line). When
    // `ATTN_AGENT_CMD_FILE` is set we instead *poll* a regular file for newly
    // appended lines — the only control channel that streams reliably into a
    // container on Docker Desktop, where both `docker run -i` stdin and
    // bind-mounted FIFOs silently drop back-to-back writes. The harness
    // bind-mounts a host file and appends one command per line; we track the
    // byte offset consumed and re-read the tail each tick, holding any trailing
    // partial (not yet newline-terminated) write for the next pass.
    match std::env::var("ATTN_AGENT_CMD_FILE")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(path) => {
            use std::io::{Read, Seek, SeekFrom};
            let mut offset: u64 = 0;
            let mut carry = String::new();
            'poll: loop {
                if let Ok(mut f) = std::fs::File::open(&path) {
                    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                    if len < offset {
                        // File was truncated/recreated — restart from the top.
                        offset = 0;
                        carry.clear();
                    }
                    if len > offset {
                        f.seek(SeekFrom::Start(offset)).ok();
                        let mut buf = String::new();
                        let n = f.read_to_string(&mut buf).unwrap_or(0) as u64;
                        offset += n;
                        carry.push_str(&buf);
                        while let Some(nl) = carry.find('\n') {
                            let line: String = carry.drain(..=nl).collect();
                            if handle_line(&line) {
                                break 'poll;
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
        None => {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if handle_line(&line) {
                    break;
                }
            }
        }
    }

    manager.submit(ReviewCommand::Stop { room_id: None });
    emit(&stdout_lock, "stopped");
    Ok(())
}

/// Room id carried by an update, if any.
fn room_id_of(update: &ReviewUpdate) -> Option<RoomId> {
    match update {
        ReviewUpdate::ShareReady { room_id, .. }
        | ReviewUpdate::RoomStatusChanged { room_id, .. }
        | ReviewUpdate::EventImported { room_id, .. }
        | ReviewUpdate::SnapshotCreated { room_id, .. }
        | ReviewUpdate::AnchorResolutionChanged { room_id, .. } => Some(room_id.clone()),
        _ => None,
    }
}

/// Print an `@agent <msg>` control line (distinct from `@update` data lines).
fn emit(lock: &StdMutex<()>, msg: &str) {
    let _g = lock.lock().expect("stdout mutex");
    println!("@agent {msg}");
    let _ = std::io::stdout().flush();
}

/// Placeholder anchor for agent-authored comments. The relay/inbound path does
/// not resolve anchors at import time, so fixed IDs are fine for convergence.
fn placeholder_anchor() -> Anchor {
    fn id<T: for<'de> serde::Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .expect("typed id deserializes")
    }
    Anchor {
        v: 2,
        file_id: id("f-file-01"),
        snapshot_id: id("eQ7pDCC-mekpz-we7gDYag"),
        base_hash: id("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
        position: PositionAnchor {
            byte_range: [0, 9],
            line_range: [1, 1],
            pm_range: None,
        },
        quote: None,
        block: None,
        context: None,
        structure: None,
    }
}
