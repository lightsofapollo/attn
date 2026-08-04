use crate::review::ids::{EventId, FileId, RoomId};
use crate::review::manager::{ReviewCommand, ReviewManager};
use crate::review::model::{Anchor, PositionAnchor, SuggestionDraft};
use crate::review::store::ReviewStore;
use crate::review::watcher_state::SelfWriteTracker;
use crate::review::working_copy::{SaveRequest, SaveResult, SaveSource, WorkingCopyService};
use crate::watcher::UserEvent;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tao::event_loop::EventLoopProxy;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum IpcMessage {
    #[serde(rename = "checkbox_toggle")]
    CheckboxToggle { line: usize, checked: bool },

    #[serde(rename = "navigate")]
    Navigate { path: String },

    #[serde(rename = "switch_project")]
    SwitchProject { path: String },

    #[serde(rename = "load_children")]
    LoadChildren { path: String },

    #[serde(rename = "search_files")]
    SearchFiles { query: String },

    #[serde(rename = "review_list_shareable_files", rename_all = "camelCase")]
    ReviewListShareableFiles { root_path: String },

    #[serde(rename = "edit_save")]
    EditSave { content: String },

    #[serde(rename = "theme_change")]
    ThemeChange { theme: String },

    #[serde(rename = "typeset_change")]
    TypesetChange { typeset: String },

    #[serde(rename = "open_external")]
    OpenExternal { path: String },

    #[serde(rename = "drag_window")]
    DragWindow,

    #[serde(rename = "zoom_window")]
    ZoomWindow,

    #[serde(rename = "open_devtools")]
    OpenDevtools,

    #[serde(rename = "resident_launch_at_login", rename_all = "camelCase")]
    ResidentLaunchAtLogin { enabled: bool },

    #[serde(rename = "js_log")]
    JsLog {
        level: String,
        message: String,
        source: Option<String>,
        stack: Option<String>,
    },

    #[serde(rename = "js_error")]
    JsError {
        message: String,
        source: String,
        line: Option<u32>,
        column: Option<u32>,
        stack: Option<String>,
    },

    #[serde(rename = "quit")]
    Quit,

    // --- Review collaboration (additive, stub-handled until issue 2.8 lands
    // the real ReviewManager wiring). Payload types come from
    // `crate::review::model` so the wire shape matches what the TypeScript
    // counterpart in `web/src/lib/types.ts` will send.
    //
    // Spec: `planning/collab/data-model.md` §Webview IPC Changes.
    #[serde(rename = "review_share", rename_all = "camelCase")]
    ReviewShare {
        path: String,
        #[serde(default)]
        selected_paths: Vec<String>,
        #[serde(default)]
        primary_path: Option<String>,
        mode: String,
        #[serde(default)]
        ttl: Option<String>,
    },

    #[serde(rename = "review_join")]
    ReviewJoin { invite: String },

    #[serde(rename = "review_create_comment", rename_all = "camelCase")]
    ReviewCreateComment {
        room_id: RoomId,
        anchor: Anchor,
        body: String,
        /// Present when this comment is a reply joining an existing thread
        /// (attn-1rm); absent/null opens a new thread.
        #[serde(default)]
        parent_thread_id: Option<String>,
    },

    #[serde(rename = "review_create_suggestion", rename_all = "camelCase")]
    ReviewCreateSuggestion {
        room_id: RoomId,
        draft: SuggestionDraft,
    },

    #[serde(rename = "review_accept_suggestion", rename_all = "camelCase")]
    ReviewAcceptSuggestion {
        room_id: RoomId,
        suggestion_id: EventId,
    },

    #[serde(rename = "review_reject_suggestion", rename_all = "camelCase")]
    ReviewRejectSuggestion {
        room_id: RoomId,
        suggestion_id: EventId,
        #[serde(default)]
        reason: Option<String>,
    },

    #[serde(rename = "review_resolve_anchor", rename_all = "camelCase")]
    ReviewResolveAnchor {
        room_id: RoomId,
        event_id: EventId,
        range: PositionAnchor,
    },

    #[serde(rename = "review_resolve_comment", rename_all = "camelCase")]
    ReviewResolveComment { room_id: RoomId, thread_id: String },

    #[serde(rename = "review_stop", rename_all = "camelCase")]
    ReviewStop {
        #[serde(default)]
        room_id: Option<RoomId>,
    },

    /// Persist the user's chosen display name (onboarding). Written to the
    /// device identity so the next Share/Join publishes it as the participant's
    /// `display_name`. An empty name clears it back to the resolved default.
    #[serde(rename = "review_set_display_name", rename_all = "camelCase")]
    ReviewSetDisplayName { name: String },

    /// Persist the user's picked identity color (attn-3gdd). Same lifecycle
    /// as the display name: written to the device identity, announced to
    /// peers via `ParticipantJoined`. Empty clears back to the automatic
    /// hash color.
    #[serde(rename = "review_set_color", rename_all = "camelCase")]
    ReviewSetColor { color: String },

    #[serde(rename = "review_collab_send", rename_all = "camelCase")]
    ReviewCollabSend {
        room_id: RoomId,
        /// Opaque prosemirror-collab JSON (submission or broadcast). The
        /// daemon shuttles it without parsing.
        payload: String,
    },

    /// Report whether one room is actually visible in a focused window.
    /// The native manager requires both flags before advancing its durable
    /// read cursor.
    #[serde(rename = "review_view_state", rename_all = "camelCase")]
    ReviewViewState {
        room_id: RoomId,
        room_visible: bool,
        window_focused: bool,
    },
    #[serde(rename = "review_notification_mute", rename_all = "camelCase")]
    ReviewNotificationMute { room_id: RoomId, muted: bool },
}

/// Shared state accessible from the IPC handler.
///
/// Routing/lookup context for the running daemon. The heavy review state
/// (event logs, working copies, transport handles) lives in `ReviewManager`
/// (issue attn-nnj.2.8); `AppState` only holds the maps the daemon needs to
/// route file/path events to the right room.
///
/// Shape pinned by `planning/collab/amendments.md` §Codebase Corrections —
/// `AppState` section.
pub struct AppState {
    pub active_path: PathBuf,
    pub active_project_root: PathBuf,
    /// Frontend's notion of the currently focused tab. Wired up when
    /// `ReviewManager` (2.8) needs to route per-tab events.
    #[allow(dead_code)]
    pub active_tab_id: Option<String>,
    /// Live review rooms keyed by `RoomId`. Inserts/removes happen in
    /// `ReviewManager` (issue attn-nnj.2.8); initialized empty here.
    #[allow(dead_code)]
    pub review_rooms: HashMap<RoomId, RoomRuntimeHandle>,
    /// Owner-side binding from a working-copy path to the `(room, file)` it
    /// belongs to. Populated by `ReviewManager` on `ReviewShare`; consulted
    /// by file watchers + IPC handlers to route events to the right room and
    /// persist `LocalRevision` journal entries (issue attn-nnj.2.5).
    ///
    /// Value is `(RoomId, FileId)` so the IPC handler can persist a
    /// revision without a second lookup through `bindings.json`. A 2.8
    /// `ReviewManager` will own population; today it's left empty by
    /// startup and grows when share/join handlers (also 2.8) land.
    #[allow(dead_code)]
    pub file_to_room: HashMap<PathBuf, (RoomId, FileId)>,
    /// Persistent review store handle. `Some` once the daemon has opened it
    /// at startup; the test harness in `mod tests` constructs an `AppState`
    /// without one when it only needs the routing maps. IPC handlers that
    /// need to persist (e.g. revision journal appends) check `is_some()`
    /// before reaching in.
    pub review_store: Option<Arc<ReviewStore>>,
    /// Shared tracker the file watcher consults to distinguish daemon
    /// self-writes from external edits (issue attn-nnj.2.6). Every IPC
    /// handler that writes through `WorkingCopyService` must construct the
    /// service with `WorkingCopyService::with_tracker(self_write_tracker.clone())`
    /// so the watcher can drop the corresponding `FsChanged` event.
    pub self_write_tracker: Arc<SelfWriteTracker>,
    /// `ReviewManager` runtime (issue attn-nnj.2.8). `Some` when the daemon
    /// successfully opened the review store at startup; the manager owns the
    /// command dispatch loop and emits `ReviewUpdate`s back into the tao
    /// event loop. Review IPC handlers submit commands here instead of
    /// performing inline work.
    pub review_manager: Option<Arc<ReviewManager>>,
    /// Per-session capability token. Minted at startup and injected ONLY into
    /// the main app frame's init payload (`window.__attn_init__.ipcToken`).
    /// `handle_message` requires it on every privileged (non-diagnostic) IPC
    /// message, so scripts inside a sandboxed HtmlViewer iframe — which never
    /// receives the token — cannot drive the daemon (write files, navigate,
    /// quit, share, …) even if they reach the native IPC bridge.
    pub ipc_token: String,
}

/// Lightweight handle for a live review room. `ReviewManager` owns the heavy
/// state (tokio task, command sender, transport handles, event log); this
/// struct is just enough for `AppState` lookups today.
///
/// Issue attn-nnj.2.8 will expand this with the actual `ReviewManager`
/// integration (e.g., tokio `JoinHandle`, command `mpsc::Sender`, etc.).
#[derive(Debug, Clone)]
pub struct RoomRuntimeHandle {
    #[allow(dead_code)]
    pub room_id: RoomId,
}

/// Whether a message of `msg_type` carrying `provided` is authorized against
/// the session's `expected` capability token.
///
/// The read-only diagnostic channels (`js_log`/`js_error`) carry no authority
/// and are tokenless — they are how a guard failure inside a sandboxed iframe
/// would surface. Every other message is privileged and must present the exact
/// session token. An empty `expected` (e.g. a `getrandom` failure that minted
/// no token) fails closed: nothing privileged is authorized.
fn ipc_message_authorized(msg_type: &str, expected: &str, provided: Option<&str>) -> bool {
    const TOKENLESS: &[&str] = &["js_log", "js_error"];
    if TOKENLESS.contains(&msg_type) {
        return true;
    }
    matches!(provided, Some(p) if !expected.is_empty() && p == expected)
}

pub fn handle_message(body: &str, state: &Arc<Mutex<AppState>>, proxy: &EventLoopProxy<UserEvent>) {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("invalid IPC message: {}", e);
            return;
        }
    };

    // Capability-token gate. Every privileged message must carry the
    // per-session token injected only into the main app frame. This stops a
    // script inside a sandboxed HtmlViewer iframe from driving the daemon even
    // if it reaches the native IPC bridge. Only the read-only diagnostic
    // channels (js_log/js_error) are tokenless — they carry no authority and
    // are how a guard failure would surface.
    let msg_type = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    let provided = value.get("token").and_then(|t| t.as_str());
    let expected = state
        .lock()
        .ok()
        .map(|s| s.ipc_token.clone())
        .unwrap_or_default();
    if !ipc_message_authorized(msg_type, &expected, provided) {
        tracing::warn!(
            "rejected privileged IPC '{}' without a valid token",
            msg_type
        );
        return;
    }

    match serde_json::from_value::<IpcMessage>(value) {
        Ok(msg) => match msg {
            IpcMessage::Quit => {
                std::process::exit(0);
            }
            IpcMessage::CheckboxToggle { line, checked } => {
                toggle_checkbox(state, line, checked);
            }
            IpcMessage::Navigate { path } => {
                let _ = proxy.send_event(UserEvent::OpenPath(PathBuf::from(path)));
            }
            IpcMessage::SwitchProject { path } => {
                let _ = proxy.send_event(UserEvent::SwitchProject(PathBuf::from(path)));
            }
            IpcMessage::LoadChildren { path } => {
                let _ = proxy.send_event(UserEvent::LoadChildren(PathBuf::from(path)));
            }
            IpcMessage::SearchFiles { query } => {
                let _ = proxy.send_event(UserEvent::SearchFiles(query));
            }
            IpcMessage::ReviewListShareableFiles { root_path } => {
                let _ = proxy.send_event(UserEvent::ListShareableFiles(PathBuf::from(root_path)));
            }
            IpcMessage::EditSave { content } => {
                // Route the write through WorkingCopyService so collab state
                // (revision journal, content hash, suggestion-accept hook)
                // stays coherent. Per `planning/collab/data-model.md`
                // §Working Copy Service the service is stateless today, so
                // it's safe to instantiate per-call until `ReviewManager`
                // (attn-nnj.2.8) holds a long-lived handle.
                let (path, tracker) = {
                    let Ok(state) = state.lock() else { return };
                    (state.active_path.clone(), state.self_write_tracker.clone())
                };
                let svc = WorkingCopyService::with_tracker(tracker);
                match svc.save(SaveRequest {
                    path: path.clone(),
                    content,
                    expected_hash: None,
                    source: SaveSource::UserEdit,
                }) {
                    Ok(result) => {
                        persist_revision_if_mapped(state, &path, &result);
                        // If this file is shared, republish a fresh snapshot so
                        // connected reviewers see the edit. The manager no-ops
                        // when the path isn't part of any room, so this is safe
                        // to fire on every save.
                        let manager = {
                            let Ok(s) = state.lock() else { return };
                            s.review_manager.clone()
                        };
                        if let Some(manager) = manager {
                            manager.submit(ReviewCommand::PublishSnapshot { path: path.clone() });
                        }
                    }
                    Err(e) => tracing::error!("failed to save: {}", e),
                }
            }
            IpcMessage::ThemeChange { theme } => {
                // Persist the PREFERENCE (light/dark/system), not the resolved
                // appearance — so a `system` user keeps following the OS across
                // restarts instead of freezing at whatever it was that night.
                tracing::info!("theme preference: {}", theme);
                if let Err(err) = crate::prefs::set_theme(&theme) {
                    tracing::warn!("could not persist theme preference: {}", err);
                }
            }
            IpcMessage::TypesetChange { typeset } => {
                tracing::info!("typeset preference: {}", typeset);
                if let Err(err) = crate::prefs::set_typeset(&typeset) {
                    tracing::warn!("could not persist typeset preference: {}", err);
                }
            }
            IpcMessage::OpenExternal { path } => {
                if !path.is_empty()
                    && let Err(err) = open::that(&path)
                {
                    tracing::warn!("failed to open external path '{}': {}", path, err);
                }
            }
            IpcMessage::DragWindow => {
                let _ = proxy.send_event(UserEvent::DragWindow);
            }
            IpcMessage::ZoomWindow => {
                let _ = proxy.send_event(UserEvent::ZoomWindow);
            }
            IpcMessage::OpenDevtools => {
                let _ = proxy.send_event(UserEvent::OpenDevtools);
            }
            IpcMessage::ResidentLaunchAtLogin { enabled } => {
                let _ = proxy.send_event(UserEvent::ResidentLaunchAtLogin { enabled });
            }
            IpcMessage::JsLog {
                level,
                message,
                source,
                stack,
            } => {
                let level = level.to_ascii_lowercase();
                match source {
                    Some(source) if !source.is_empty() => {
                        tracing::debug!("js {level}: {message} ({source})");
                    }
                    _ => {
                        tracing::debug!("js {level}: {message}");
                    }
                }
                if let Some(stack) = stack
                    && !stack.is_empty()
                {
                    tracing::debug!("js {level} stack:\n{stack}");
                }
            }
            IpcMessage::JsError {
                message,
                source,
                line,
                column,
                stack,
            } => {
                let line = line.unwrap_or(0);
                let column = column.unwrap_or(0);
                tracing::warn!("js error: {message} ({source}:{line}:{column})");
                if let Some(stack) = stack
                    && !stack.is_empty()
                {
                    tracing::warn!("js error stack:\n{stack}");
                }
            }
            // Review collaboration handlers. Dispatch each message to
            // `ReviewManager::submit` (issue attn-nnj.2.8). The manager logs
            // the command and emits a stub `ReviewUpdate` back through the
            // event loop → `window.__attn__.review*` callback round-trip;
            // real handler bodies land in later issues.
            IpcMessage::ReviewShare {
                path,
                selected_paths,
                primary_path,
                mode,
                ttl,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::Share {
                        path: PathBuf::from(path),
                        selected_paths: selected_paths.into_iter().map(PathBuf::from).collect(),
                        primary_path: primary_path.map(PathBuf::from),
                        mode,
                        ttl,
                    },
                );
            }
            IpcMessage::ReviewJoin { invite } => {
                submit_review_command(state, ReviewCommand::Join { invite });
            }
            IpcMessage::ReviewCreateComment {
                room_id,
                anchor,
                body,
                parent_thread_id,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::CreateComment {
                        room_id,
                        anchor,
                        body,
                        parent_thread_id,
                    },
                );
            }
            IpcMessage::ReviewCreateSuggestion { room_id, draft } => {
                submit_review_command(state, ReviewCommand::CreateSuggestion { room_id, draft });
            }
            IpcMessage::ReviewAcceptSuggestion {
                room_id,
                suggestion_id,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::AcceptSuggestion {
                        room_id,
                        suggestion_id,
                    },
                );
            }
            IpcMessage::ReviewRejectSuggestion {
                room_id,
                suggestion_id,
                reason,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::RejectSuggestion {
                        room_id,
                        suggestion_id,
                        reason,
                    },
                );
            }
            IpcMessage::ReviewResolveAnchor {
                room_id,
                event_id,
                range,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::ResolveAnchor {
                        room_id,
                        event_id,
                        range,
                    },
                );
            }
            IpcMessage::ReviewResolveComment { room_id, thread_id } => {
                submit_review_command(state, ReviewCommand::ResolveComment { room_id, thread_id });
            }
            IpcMessage::ReviewStop { room_id } => {
                submit_review_command(state, ReviewCommand::Stop { room_id });
            }
            IpcMessage::ReviewCollabSend { room_id, payload } => {
                submit_review_command(state, ReviewCommand::SendCollab { room_id, payload });
            }
            IpcMessage::ReviewViewState {
                room_id,
                room_visible,
                window_focused,
            } => {
                submit_review_command(
                    state,
                    ReviewCommand::SetViewState {
                        room_id,
                        room_visible,
                        window_focused,
                    },
                );
            }
            IpcMessage::ReviewNotificationMute { room_id, muted } => {
                submit_review_command(
                    state,
                    ReviewCommand::SetNotificationMuted { room_id, muted },
                );
            }
            IpcMessage::ReviewSetDisplayName { name } => {
                // Direct identity write, then a manager command to re-announce
                // the new name into every ACTIVE room — the onboarding prompt
                // fires after a room is entered, so without the re-announce a
                // name typed there never reached the already-joined room and
                // comments kept showing the stale identity. Don't log the name.
                match crate::review::bootstrap::set_display_name(&name) {
                    Ok(_) => {
                        tracing::info!("review display name updated");
                        submit_review_command(state, ReviewCommand::ReannounceIdentity);
                    }
                    Err(e) => tracing::warn!("failed to set display name: {e}"),
                }
            }
            IpcMessage::ReviewSetColor { color } => {
                // Same write-then-reannounce shape as the display name above:
                // the picked color must reach rooms that are already live, not
                // just the next Share/Join.
                match crate::review::bootstrap::set_color(&color) {
                    Ok(_) => {
                        tracing::info!("review identity color updated");
                        submit_review_command(state, ReviewCommand::ReannounceIdentity);
                    }
                    Err(e) => tracing::warn!("failed to set identity color: {e}"),
                }
            }
        },
        Err(e) => {
            tracing::error!("invalid IPC message: {}", e);
        }
    }
}

/// Toggle a checkbox on a specific line (1-based) in the markdown file.
/// Replaces `- [ ]` with `- [x]` or vice versa, then writes the file back
/// through `WorkingCopyService` so the change participates in collab
/// revision tracking. The file watcher will detect the write and trigger a
/// re-render.
fn toggle_checkbox(state: &Arc<Mutex<AppState>>, line: usize, checked: bool) {
    let (path, tracker) = {
        let Ok(state) = state.lock() else { return };
        (state.active_path.clone(), state.self_write_tracker.clone())
    };

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("could not read file for checkbox toggle: {}", e);
            return;
        }
    };

    let mut lines: Vec<&str> = content.lines().collect();

    // line is 1-based from the structure
    let idx = line.wrapping_sub(1);
    if idx >= lines.len() {
        tracing::warn!("checkbox toggle line {} out of range", line);
        return;
    }

    let current_line = lines[idx];
    let new_line;
    let replaced: String;

    if checked {
        // Want to check: replace `- [ ]` with `- [x]`
        replaced = current_line.replacen("- [ ]", "- [x]", 1);
        new_line = replaced.as_str();
    } else {
        // Want to uncheck: replace `- [x]` or `- [X]` with `- [ ]`
        replaced = current_line
            .replacen("- [x]", "- [ ]", 1)
            .replacen("- [X]", "- [ ]", 1);
        new_line = replaced.as_str();
    }

    if new_line == current_line {
        tracing::warn!("line {} does not contain a checkbox", line);
        return;
    }

    lines[idx] = new_line;

    // Preserve trailing newline if the original file had one
    let mut output = lines.join("\n");
    if content.ends_with('\n') {
        output.push('\n');
    }

    let svc = WorkingCopyService::with_tracker(tracker);
    match svc.save(SaveRequest {
        path: path.clone(),
        content: output,
        expected_hash: None,
        source: SaveSource::CheckboxToggle,
    }) {
        Ok(result) => persist_revision_if_mapped(state, &path, &result),
        Err(e) => tracing::error!("could not write file after checkbox toggle: {}", e),
    }
}

/// Forward a `ReviewCommand` to the `ReviewManager` if one is wired up.
///
/// When the daemon failed to open a review store at startup the manager is
/// `None` — we log so the user can see the command was received but otherwise
/// no-op. The manager itself logs every command and emits a `ReviewUpdate`
/// back through the event loop, so a successful dispatch is observable in
/// devtools without any work from this helper.
fn submit_review_command(state: &Arc<Mutex<AppState>>, cmd: ReviewCommand) {
    let manager = {
        let Ok(state) = state.lock() else {
            tracing::error!("review command dropped — AppState lock poisoned");
            return;
        };
        state.review_manager.clone()
    };
    match manager {
        Some(manager) => manager.submit(cmd),
        None => tracing::warn!("review command dropped — ReviewManager unavailable: {cmd:?}"),
    }
}

/// If `path` is mapped to a `(room, file)` AND the daemon has a
/// `ReviewStore` open, append the `LocalRevision` returned by
/// `WorkingCopyService::save` to the room's revision journal. Otherwise
/// silently no-op — non-collab files still flow through `WorkingCopyService`
/// for the atomic write + hashing but don't generate persistent journal
/// entries.
///
/// Per attn-nnj.2.5 issue spec: this lives in IPC for now (Option A) and
/// gets subsumed by `ReviewManager` (attn-nnj.2.8) once that exists.
fn persist_revision_if_mapped(state: &Arc<Mutex<AppState>>, path: &Path, result: &SaveResult) {
    let Ok(state) = state.lock() else { return };
    let Some(store) = state.review_store.as_ref() else {
        return;
    };
    let Some((room_id, file_id)) = state.file_to_room.get(path) else {
        return;
    };
    if let Err(err) = store.append_revision(room_id, file_id, &result.revision) {
        tracing::warn!(
            "failed to append local revision for {}: {}",
            path.display(),
            err
        );
    }
}

/// Append a `LocalRevision` to the room's journal if `path` is mapped to a
/// `(room, file)` AND a `ReviewStore` is open. Same routing as
/// [`persist_revision_if_mapped`] but takes a bare `LocalRevision` rather
/// than a `SaveResult` — used by the file watcher's external-change path
/// (attn-nnj.2.6) where there is no `WorkingCopyService::save` call.
pub fn append_revision_if_mapped(
    state: &Arc<Mutex<AppState>>,
    path: &Path,
    revision: &crate::review::model::LocalRevision,
) {
    let Ok(state) = state.lock() else { return };
    let Some(store) = state.review_store.as_ref() else {
        return;
    };
    let Some((room_id, file_id)) = state.file_to_room.get(path) else {
        return;
    };
    if let Err(err) = store.append_revision(room_id, file_id, revision) {
        tracing::warn!(
            "failed to append external local revision for {}: {}",
            path.display(),
            err
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::ContentHash;
    use crate::review::model::{LocalRevision, RevisionSource};
    use crate::review::working_copy::{SaveSource, WorkingCopyService};
    use serde_json::Value;
    use tempfile::TempDir;

    fn make_state(
        active_path: PathBuf,
        review_store: Option<Arc<ReviewStore>>,
        file_to_room: HashMap<PathBuf, (RoomId, FileId)>,
    ) -> Arc<Mutex<AppState>> {
        make_state_with_manager(active_path, review_store, file_to_room, None)
    }

    fn make_state_with_manager(
        active_path: PathBuf,
        review_store: Option<Arc<ReviewStore>>,
        file_to_room: HashMap<PathBuf, (RoomId, FileId)>,
        review_manager: Option<Arc<ReviewManager>>,
    ) -> Arc<Mutex<AppState>> {
        Arc::new(Mutex::new(AppState {
            active_path: active_path.clone(),
            active_project_root: active_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default(),
            active_tab_id: None,
            review_rooms: HashMap::new(),
            file_to_room,
            review_store,
            self_write_tracker: Arc::new(SelfWriteTracker::new()),
            review_manager,
            ipc_token: "test-token".to_string(),
        }))
    }

    fn dummy_id<T: for<'de> serde::Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("id deserializes")
    }

    fn dummy_revision() -> LocalRevision {
        LocalRevision {
            revision_id: "rev-1".to_string(),
            parent_hash: dummy_id::<ContentHash>("h-prev"),
            next_hash: dummy_id::<ContentHash>("h-next"),
            created_at: 1_700_000_000_100,
            source: RevisionSource::ProsemirrorEdit,
            pm_steps: None,
            patch_text: None,
        }
    }

    fn dummy_save_result() -> SaveResult {
        SaveResult {
            previous_hash: dummy_id::<ContentHash>("h-prev"),
            next_hash: dummy_id::<ContentHash>("h-next"),
            revision: dummy_revision(),
        }
    }

    #[test]
    fn persist_revision_if_mapped_no_op_when_path_unmapped() {
        // The classic EditSave path: file is not part of any room (no
        // `ReviewShare` has happened). `WorkingCopyService::save` builds a
        // `LocalRevision` and returns it, but the IPC handler must NOT try
        // to call `append_revision` — nothing should hit disk or panic.
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"# hi\n").expect("seed file");

        let state = make_state(active_path.clone(), Some(store.clone()), HashMap::new());
        // No-op: must not panic, must not write anything under reviews/.
        persist_revision_if_mapped(&state, &active_path, &dummy_save_result());

        // The reviews/rooms/ directory should not have been created — the
        // helper short-circuited before touching the store.
        let rooms_dir = tmp.path().join("reviews").join("rooms");
        assert!(
            !rooms_dir.exists(),
            "expected no rooms dir, got {}",
            rooms_dir.display()
        );
    }

    #[test]
    fn persist_revision_if_mapped_writes_when_path_is_in_a_room() {
        // When the path IS bound to a (room, file), the helper must append
        // the revision and the journal must be observable via iter_revisions.
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"# hi\n").expect("seed file");

        let room_id: RoomId = dummy_id("room-abc");
        let file_id: FileId = dummy_id("file-1");
        let mut map = HashMap::new();
        map.insert(active_path.clone(), (room_id.clone(), file_id.clone()));

        let state = make_state(active_path.clone(), Some(store.clone()), map);
        persist_revision_if_mapped(&state, &active_path, &dummy_save_result());

        let journal: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_id)
            .expect("iter")
            .collect::<Result<_, _>>()
            .expect("decode");
        assert_eq!(journal, vec![dummy_revision()]);
    }

    #[test]
    fn persist_revision_if_mapped_no_op_when_store_missing() {
        // Defensive: AppState may carry `review_store = None` if the daemon
        // failed to open the store at startup. The helper must not panic.
        let tmp = TempDir::new().expect("tempdir");
        let active_path = tmp.path().join("doc.md");
        let mut map = HashMap::new();
        map.insert(
            active_path.clone(),
            (dummy_id::<RoomId>("room-x"), dummy_id::<FileId>("file-x")),
        );

        let state = make_state(active_path.clone(), None, map);
        persist_revision_if_mapped(&state, &active_path, &dummy_save_result());
        // No assertion needed beyond "did not panic / did not lock-poison".
    }

    #[test]
    fn edit_save_unmapped_path_succeeds_without_persisting_revision() {
        // End-to-end smoke for the EditSave path: WorkingCopyService writes
        // the file, but with no room mapping the revision is built and
        // discarded. The reviews/rooms/ tree stays empty.
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"));
        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"old\n").expect("seed file");

        let state = make_state(active_path.clone(), Some(store.clone()), HashMap::new());

        // Simulate what the EditSave arm does after WorkingCopyService::save.
        let svc = WorkingCopyService::new();
        let result = svc
            .save(SaveRequest {
                path: active_path.clone(),
                content: "new\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save");
        persist_revision_if_mapped(&state, &active_path, &result);

        // File on disk reflects the save.
        assert_eq!(std::fs::read(&active_path).expect("read"), b"new\n");
        // No room directories were created.
        let rooms_dir = tmp.path().join("reviews").join("rooms");
        assert!(!rooms_dir.exists());
    }

    #[test]
    fn ipc_message_review_share_parses_minimal() {
        let raw = r#"{"type":"review_share","path":"/tmp/plan.md","mode":"async"}"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse review_share");
        match msg {
            IpcMessage::ReviewShare {
                path,
                selected_paths,
                primary_path,
                mode,
                ttl,
            } => {
                assert_eq!(path, "/tmp/plan.md");
                assert!(selected_paths.is_empty());
                assert!(primary_path.is_none());
                assert_eq!(mode, "async");
                assert!(ttl.is_none());
            }
            other => panic!("expected ReviewShare, got {other:?}"),
        }
    }

    #[test]
    fn ipc_message_review_share_parses_exact_file_selection() {
        let raw = r#"{
            "type":"review_share",
            "path":"/tmp/project",
            "selectedPaths":["/tmp/project/a.md","/tmp/project/docs/b.md"],
            "primaryPath":"/tmp/project/docs/b.md",
            "mode":"hybrid"
        }"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse selected review_share");
        match msg {
            IpcMessage::ReviewShare {
                path,
                selected_paths,
                primary_path,
                mode,
                ttl,
            } => {
                assert_eq!(path, "/tmp/project");
                assert_eq!(
                    selected_paths,
                    vec!["/tmp/project/a.md", "/tmp/project/docs/b.md"]
                );
                assert_eq!(primary_path.as_deref(), Some("/tmp/project/docs/b.md"));
                assert_eq!(mode, "hybrid");
                assert!(ttl.is_none());
            }
            other => panic!("expected ReviewShare, got {other:?}"),
        }
    }

    #[test]
    fn ipc_message_review_resolve_anchor_parses_camel_case_payload() {
        // Confirms the typed payload (RoomId, EventId, PositionAnchor) round-trips
        // via the same camelCase wire shape that web/src/lib/types.ts will emit.
        let raw = r#"{
            "type":"review_resolve_anchor",
            "roomId":"room-abc",
            "eventId":"evt-1",
            "range":{"byteRange":[0,5],"lineRange":[1,1]}
        }"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse review_resolve_anchor");
        assert!(matches!(msg, IpcMessage::ReviewResolveAnchor { .. }));
    }

    #[test]
    fn ipc_message_review_create_comment_parses_reply_and_root() {
        // Reply: carries parentThreadId.
        let reply = r#"{"type":"review_create_comment","roomId":"room-abc","anchor":{"v":2,"fileId":"f1","snapshotId":"s1","baseHash":"h1","position":{"byteRange":[0,3],"lineRange":[1,1]}},"body":"agreed","parentThreadId":"thread-1"}"#;
        let msg: IpcMessage = serde_json::from_str(reply).expect("parse reply comment");
        match msg {
            IpcMessage::ReviewCreateComment {
                parent_thread_id, ..
            } => assert_eq!(parent_thread_id.as_deref(), Some("thread-1")),
            other => panic!("expected ReviewCreateComment, got {other:?}"),
        }
        // Root comment: no parentThreadId → None (serde default), so old
        // payloads keep parsing.
        let root = r#"{"type":"review_create_comment","roomId":"room-abc","anchor":{"v":2,"fileId":"f1","snapshotId":"s1","baseHash":"h1","position":{"byteRange":[0,3],"lineRange":[1,1]}},"body":"hi"}"#;
        let msg: IpcMessage = serde_json::from_str(root).expect("parse root comment");
        match msg {
            IpcMessage::ReviewCreateComment {
                parent_thread_id, ..
            } => assert!(parent_thread_id.is_none()),
            other => panic!("expected ReviewCreateComment, got {other:?}"),
        }
    }

    #[test]
    fn ipc_message_review_resolve_comment_parses_camel_case_payload() {
        let raw = r#"{"type":"review_resolve_comment","roomId":"room-abc","threadId":"thread-1"}"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse review_resolve_comment");
        match msg {
            IpcMessage::ReviewResolveComment { room_id, thread_id } => {
                assert_eq!(room_id.as_str(), "room-abc");
                assert_eq!(thread_id, "thread-1");
            }
            other => panic!("expected ReviewResolveComment, got {other:?}"),
        }
    }

    #[test]
    fn ipc_message_review_stop_parses_optional_room() {
        let raw = r#"{"type":"review_stop","roomId":"room-abc"}"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse review_stop");
        assert!(matches!(msg, IpcMessage::ReviewStop { room_id: Some(_) }));

        let raw_all = r#"{"type":"review_stop"}"#;
        let msg_all: IpcMessage = serde_json::from_str(raw_all).expect("parse review_stop all");
        assert!(matches!(msg_all, IpcMessage::ReviewStop { room_id: None }));
    }

    #[test]
    fn ipc_message_review_view_state_parses_both_focus_predicates() {
        let raw = r#"{"type":"review_view_state","roomId":"room-abc","roomVisible":true,"windowFocused":false}"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse review_view_state");
        assert!(matches!(
            msg,
            IpcMessage::ReviewViewState {
                room_visible: true,
                window_focused: false,
                ..
            }
        ));
    }

    #[test]
    fn ipc_message_review_notification_mute_parses_persisted_toggle() {
        let raw = r#"{"type":"review_notification_mute","roomId":"room-abc","muted":true}"#;
        let msg: IpcMessage = serde_json::from_str(raw).expect("parse notification mute");
        assert!(matches!(
            msg,
            IpcMessage::ReviewNotificationMute { muted: true, .. }
        ));
    }

    #[test]
    fn ipc_message_review_reject_suggestion_parses_with_and_without_reason() {
        // The Reject button omits `reason`; the field is `#[serde(default)]`.
        let with_reason = r#"{"type":"review_reject_suggestion","roomId":"room-abc","suggestionId":"sugg-1","reason":"out of scope"}"#;
        let msg: IpcMessage =
            serde_json::from_str(with_reason).expect("parse review_reject_suggestion with reason");
        if let IpcMessage::ReviewRejectSuggestion { reason, .. } = msg {
            assert_eq!(reason.as_deref(), Some("out of scope"));
        } else {
            panic!("expected ReviewRejectSuggestion");
        }

        let no_reason =
            r#"{"type":"review_reject_suggestion","roomId":"room-abc","suggestionId":"sugg-1"}"#;
        let msg: IpcMessage =
            serde_json::from_str(no_reason).expect("parse review_reject_suggestion without reason");
        assert!(matches!(
            msg,
            IpcMessage::ReviewRejectSuggestion { reason: None, .. }
        ));
    }

    // -----------------------------------------------------------------
    // ReviewManager dispatch round-trip (attn-nnj.2.8)
    // -----------------------------------------------------------------

    use crate::review::manager::{ReviewUpdate, UpdateSink};
    use std::sync::Mutex as StdMutex;
    use std::sync::mpsc;

    /// Build a `ReviewManager` whose `update_tx` writes into an std::mpsc
    /// channel so tests can assert which `ReviewUpdate`s fired without
    /// pulling in the tao event loop.
    fn make_test_manager(
        store: Arc<ReviewStore>,
    ) -> (Arc<ReviewManager>, mpsc::Receiver<ReviewUpdate>) {
        let (tx, rx) = mpsc::channel::<ReviewUpdate>();
        let tx = StdMutex::new(tx);
        let sink: UpdateSink = Arc::new(move |update| {
            let _ = tx.lock().expect("test sink mutex").send(update);
        });
        let working_copy = Arc::new(WorkingCopyService::new());
        (Arc::new(ReviewManager::new(store, working_copy, sink)), rx)
    }

    fn dummy_review_store(tmp: &TempDir) -> Arc<ReviewStore> {
        Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"))
    }

    /// Helper: parse a raw IPC body to an `IpcMessage`, extract the review
    /// command shape, and dispatch directly via `submit_review_command`.
    ///
    /// We can't call `handle_message` from tests on macOS because creating an
    /// `EventLoopProxy` requires a tao `EventLoop`, which must be built on
    /// the main thread. The Review IPC arms don't use the proxy anyway —
    /// they only touch `submit_review_command` — so this helper exercises the
    /// same code path without dragging in tao.
    fn dispatch_review_ipc(body: &str, state: &Arc<Mutex<AppState>>) {
        let msg: IpcMessage = serde_json::from_str(body).expect("parse IpcMessage");
        let cmd = match msg {
            IpcMessage::ReviewShare {
                path,
                selected_paths,
                primary_path,
                mode,
                ttl,
            } => ReviewCommand::Share {
                path: PathBuf::from(path),
                selected_paths: selected_paths.into_iter().map(PathBuf::from).collect(),
                primary_path: primary_path.map(PathBuf::from),
                mode,
                ttl,
            },
            IpcMessage::ReviewJoin { invite } => ReviewCommand::Join { invite },
            IpcMessage::ReviewCreateComment {
                room_id,
                anchor,
                body,
                parent_thread_id,
            } => ReviewCommand::CreateComment {
                room_id,
                anchor,
                body,
                parent_thread_id,
            },
            IpcMessage::ReviewCreateSuggestion { room_id, draft } => {
                ReviewCommand::CreateSuggestion { room_id, draft }
            }
            IpcMessage::ReviewAcceptSuggestion {
                room_id,
                suggestion_id,
            } => ReviewCommand::AcceptSuggestion {
                room_id,
                suggestion_id,
            },
            IpcMessage::ReviewRejectSuggestion {
                room_id,
                suggestion_id,
                reason,
            } => ReviewCommand::RejectSuggestion {
                room_id,
                suggestion_id,
                reason,
            },
            IpcMessage::ReviewResolveAnchor {
                room_id,
                event_id,
                range,
            } => ReviewCommand::ResolveAnchor {
                room_id,
                event_id,
                range,
            },
            IpcMessage::ReviewResolveComment { room_id, thread_id } => {
                ReviewCommand::ResolveComment { room_id, thread_id }
            }
            IpcMessage::ReviewStop { room_id } => ReviewCommand::Stop { room_id },
            IpcMessage::ReviewViewState {
                room_id,
                room_visible,
                window_focused,
            } => ReviewCommand::SetViewState {
                room_id,
                room_visible,
                window_focused,
            },
            IpcMessage::ReviewNotificationMute { room_id, muted } => {
                ReviewCommand::SetNotificationMuted { room_id, muted }
            }
            other => panic!("not a review IpcMessage: {other:?}"),
        };
        submit_review_command(state, cmd);
    }

    #[test]
    fn ipc_review_share_routes_through_manager_and_emits_update() {
        // Round-trip: an IPC ReviewShare message dispatched through
        // submit_review_command must reach the ReviewManager (which emits
        // exactly one stub RoomStatusChanged update). This is the test that
        // proves the IPC -> Manager wiring works.
        let tmp = TempDir::new().expect("tempdir");
        let store = dummy_review_store(&tmp);
        let (manager, rx) = make_test_manager(store.clone());

        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"# hi\n").expect("seed file");
        let state =
            make_state_with_manager(active_path, Some(store), HashMap::new(), Some(manager));

        let body = r#"{"type":"review_share","path":"/tmp/plan.md","mode":"live"}"#;
        dispatch_review_ipc(body, &state);

        let update = rx
            .try_recv()
            .expect("manager should have received one update");
        match update {
            ReviewUpdate::RoomStatusChanged { status, .. } => {
                assert!(
                    status.contains("Pending share"),
                    "expected pending-share stub, got: {status}"
                );
            }
            other => panic!("expected RoomStatusChanged, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "ReviewManager should emit exactly one update per command"
        );
    }

    #[test]
    fn ipc_review_view_state_clears_only_focused_visible_room() {
        let tmp = TempDir::new().expect("tempdir");
        let store = dummy_review_store(&tmp);
        let room_id: RoomId = dummy_id("room-unread-ipc");
        store
            .record_unread_event(&room_id, &dummy_id("evt-unread-ipc"))
            .expect("seed unread");
        let (manager, rx) = make_test_manager(store.clone());
        let state = make_state_with_manager(
            tmp.path().join("doc.md"),
            Some(store.clone()),
            HashMap::new(),
            Some(manager),
        );

        dispatch_review_ipc(
            r#"{"type":"review_view_state","roomId":"room-unread-ipc","roomVisible":true,"windowFocused":false}"#,
            &state,
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(
            store
                .load_unread_state(&room_id)
                .expect("still unread")
                .unread_count,
            1
        );

        dispatch_review_ipc(
            r#"{"type":"review_view_state","roomId":"room-unread-ipc","roomVisible":true,"windowFocused":true}"#,
            &state,
        );
        assert!(matches!(
            rx.try_recv().expect("unread clear update"),
            ReviewUpdate::UnreadChanged {
                unread_count: 0,
                ..
            }
        ));
    }

    #[test]
    fn ipc_review_create_comment_routes_through_manager() {
        // Same round-trip shape as the share test, but for the typed
        // CreateComment payload — this is the path the comment composer in
        // the frontend will use.
        let tmp = TempDir::new().expect("tempdir");
        let store = dummy_review_store(&tmp);
        let (manager, rx) = make_test_manager(store.clone());

        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"# hi\n").expect("seed file");
        let state =
            make_state_with_manager(active_path, Some(store), HashMap::new(), Some(manager));

        let body = r#"{
            "type":"review_create_comment",
            "roomId":"room-abc",
            "anchor":{
                "v":2,
                "fileId":"file-1",
                "snapshotId":"snap-1",
                "baseHash":"hash-1",
                "position":{"byteRange":[0,5],"lineRange":[1,1]}
            },
            "body":"looks great"
        }"#;
        dispatch_review_ipc(body, &state);

        let update = rx
            .try_recv()
            .expect("manager should have received one update");
        match update {
            ReviewUpdate::EventImported { event, .. } => {
                assert!(
                    matches!(
                        event.body,
                        crate::review::model::ReviewEventBody::CommentCreated { .. }
                    ),
                    "expected CommentCreated body, got {:?}",
                    event.body
                );
            }
            other => panic!("expected EventImported, got {other:?}"),
        }
    }

    #[test]
    fn ipc_review_command_drops_silently_when_manager_unavailable() {
        // Defensive: when the daemon couldn't open the review store at
        // startup, `review_manager` is None. IPC handlers must not panic;
        // they just log and continue.
        let tmp = TempDir::new().expect("tempdir");
        let active_path = tmp.path().join("doc.md");
        std::fs::write(&active_path, b"# hi\n").expect("seed file");
        let state = make_state_with_manager(active_path, None, HashMap::new(), None);

        let body = r#"{"type":"review_share","path":"/tmp/plan.md","mode":"live"}"#;
        dispatch_review_ipc(body, &state);
        // No assertion — the test passes if we did not panic / poison locks.
    }

    #[test]
    fn privileged_ipc_requires_matching_token() {
        // Write-class messages from an embedded (untrusted) frame carry no
        // token, or the wrong one — both must be rejected.
        assert!(!ipc_message_authorized("edit_save", "secret", None));
        assert!(!ipc_message_authorized(
            "edit_save",
            "secret",
            Some("wrong")
        ));
        assert!(!ipc_message_authorized("navigate", "secret", Some("")));
        // The legitimate main frame presents the exact session token.
        assert!(ipc_message_authorized(
            "edit_save",
            "secret",
            Some("secret")
        ));
        assert!(ipc_message_authorized(
            "checkbox_toggle",
            "secret",
            Some("secret")
        ));
    }

    #[test]
    fn diagnostic_ipc_is_tokenless() {
        // js_log / js_error carry no authority and must pass without a token so
        // a guard failure inside a sandboxed iframe can still surface.
        assert!(ipc_message_authorized("js_log", "secret", None));
        assert!(ipc_message_authorized("js_error", "secret", None));
    }

    #[test]
    fn empty_session_token_fails_closed() {
        // If the daemon minted no token (getrandom failure), nothing privileged
        // is authorized — even a message that echoes the empty token.
        assert!(!ipc_message_authorized("edit_save", "", Some("")));
        assert!(!ipc_message_authorized("navigate", "", None));
        // Diagnostics remain allowed regardless.
        assert!(ipc_message_authorized("js_error", "", None));
    }
}
