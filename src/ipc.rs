use crate::review::ids::{EventId, FileId, RoomId};
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

    #[serde(rename = "edit_save")]
    EditSave { content: String },

    #[serde(rename = "theme_change")]
    ThemeChange { theme: String },

    #[serde(rename = "open_external")]
    OpenExternal { path: String },

    #[serde(rename = "drag_window")]
    DragWindow,

    #[serde(rename = "open_devtools")]
    OpenDevtools,

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

    #[serde(rename = "review_resolve_anchor", rename_all = "camelCase")]
    ReviewResolveAnchor {
        room_id: RoomId,
        event_id: EventId,
        range: PositionAnchor,
    },
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

pub fn handle_message(body: &str, state: &Arc<Mutex<AppState>>, proxy: &EventLoopProxy<UserEvent>) {
    match serde_json::from_str::<IpcMessage>(body) {
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
                    Ok(result) => persist_revision_if_mapped(state, &path, &result),
                    Err(e) => eprintln!("attn: failed to save: {}", e),
                }
            }
            IpcMessage::ThemeChange { theme } => {
                eprintln!("theme change: {}", theme);
            }
            IpcMessage::OpenExternal { path } => {
                if !path.is_empty()
                    && let Err(err) = open::that(&path)
                {
                    eprintln!("attn: failed to open external path '{}': {}", path, err);
                }
            }
            IpcMessage::DragWindow => {
                let _ = proxy.send_event(UserEvent::DragWindow);
            }
            IpcMessage::OpenDevtools => {
                let _ = proxy.send_event(UserEvent::OpenDevtools);
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
                        eprintln!("attn: js {level}: {message} ({source})");
                    }
                    _ => {
                        eprintln!("attn: js {level}: {message}");
                    }
                }
                if let Some(stack) = stack
                    && !stack.is_empty()
                {
                    eprintln!("attn: js {level} stack:\n{stack}");
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
                eprintln!("attn: js error: {message} ({source}:{line}:{column})");
                if let Some(stack) = stack
                    && !stack.is_empty()
                {
                    eprintln!("attn: js error stack:\n{stack}");
                }
            }
            // Review collaboration stub handlers. Real wiring lives in
            // `ReviewManager` (issue attn-nnj.2.8). For now we log the call
            // so the frontend stubs (attn-nnj.12.5) can confirm messages
            // round-trip through the webview IPC boundary.
            IpcMessage::ReviewShare { path, mode, ttl } => {
                eprintln!(
                    "attn: review_share received (stub): path={path} mode={mode} ttl={:?}",
                    ttl
                );
            }
            IpcMessage::ReviewJoin { invite } => {
                eprintln!("attn: review_join received (stub): invite={invite}");
            }
            IpcMessage::ReviewCreateComment {
                room_id,
                anchor,
                body,
            } => {
                eprintln!(
                    "attn: review_create_comment received (stub): room={:?} body_len={} anchor_v={}",
                    room_id,
                    body.len(),
                    anchor.v
                );
            }
            IpcMessage::ReviewCreateSuggestion { room_id, draft } => {
                eprintln!(
                    "attn: review_create_suggestion received (stub): room={:?} anchor_v={}",
                    room_id, draft.anchor.v
                );
            }
            IpcMessage::ReviewAcceptSuggestion {
                room_id,
                suggestion_id,
            } => {
                eprintln!(
                    "attn: review_accept_suggestion received (stub): room={:?} suggestion={:?}",
                    room_id, suggestion_id
                );
            }
            IpcMessage::ReviewResolveAnchor {
                room_id,
                event_id,
                range,
            } => {
                eprintln!(
                    "attn: review_resolve_anchor received (stub): room={:?} event={:?} byte_range={:?}",
                    room_id, event_id, range.byte_range
                );
            }
        },
        Err(e) => {
            eprintln!("attn: invalid IPC message: {}", e);
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
            eprintln!("attn: could not read file for checkbox toggle: {}", e);
            return;
        }
    };

    let mut lines: Vec<&str> = content.lines().collect();

    // line is 1-based from the structure
    let idx = line.wrapping_sub(1);
    if idx >= lines.len() {
        eprintln!("attn: checkbox toggle line {} out of range", line);
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
        eprintln!("attn: line {} does not contain a checkbox", line);
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
        Err(e) => eprintln!("attn: could not write file after checkbox toggle: {}", e),
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
        eprintln!(
            "attn: failed to append local revision for {}: {}",
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
        eprintln!(
            "attn: failed to append external local revision for {}: {}",
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
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
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
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
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
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("open store"),
        );
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
            IpcMessage::ReviewShare { path, mode, ttl } => {
                assert_eq!(path, "/tmp/plan.md");
                assert_eq!(mode, "async");
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
}
