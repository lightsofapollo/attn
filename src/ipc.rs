use crate::review::ids::{EventId, RoomId};
use crate::review::model::{Anchor, PositionAnchor, SuggestionDraft};
use crate::watcher::UserEvent;
use serde::Deserialize;
use std::path::PathBuf;
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
pub struct AppState {
    pub file_path: PathBuf,
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
                let Ok(state) = state.lock() else { return };
                if let Err(e) = std::fs::write(&state.file_path, &content) {
                    eprintln!("attn: failed to save: {}", e);
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
/// Replaces `- [ ]` with `- [x]` or vice versa, then writes the file back.
/// The file watcher will detect the write and trigger a re-render.
fn toggle_checkbox(state: &Arc<Mutex<AppState>>, line: usize, checked: bool) {
    let Ok(state) = state.lock() else { return };
    let path = &state.file_path;

    let content = match std::fs::read_to_string(path) {
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

    if let Err(e) = std::fs::write(path, &output) {
        eprintln!("attn: could not write file after checkbox toggle: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
