use std::collections::HashMap;
use std::process::Command;

use attn::review::crypto::ids::content_hash;
use attn::review::feedback::{FeedbackFreshness, FeedbackSnapshot};
use attn::review::ids::{DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId};
use attn::review::model::{
    Anchor, EventAuth, EventMeta, LocalFileBinding, PositionAnchor, ReviewEvent, ReviewEventBody,
};
use attn::review::store::ReviewStore;
use serde::Deserialize;
use tempfile::TempDir;

fn id<T: for<'de> Deserialize<'de>>(value: &str) -> T {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).expect("string id")
}

fn fixture() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().expect("tempdir");
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).expect("project");
    let path = project.join("brief.md");
    let source = b"# Brief\n\nOriginal copy.\n";
    std::fs::write(&path, source).expect("source");
    let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("store");
    let room_id: RoomId = id("room-cli-feedback");
    let file_id: FileId = id("file-brief");
    let snapshot_id: SnapshotId = id("snapshot-brief");
    let mut bindings = HashMap::new();
    bindings.insert(
        file_id.clone(),
        LocalFileBinding {
            file_id: file_id.clone(),
            absolute_path: path.to_string_lossy().into_owned(),
            project_root: project.to_string_lossy().into_owned(),
        },
    );
    store.save_bindings(&room_id, &bindings).expect("bindings");
    let anchor = Anchor {
        v: 2,
        file_id,
        snapshot_id,
        base_hash: content_hash(source),
        position: PositionAnchor {
            byte_range: [9, 22],
            line_range: [3, 3],
            pm_range: None,
        },
        quote: None,
        block: None,
        context: None,
        structure: None,
        html: None,
    };
    let event = ReviewEvent {
        meta: EventMeta {
            v: 2,
            event_id: id::<EventId>("event-cli-feedback"),
            room_id: room_id.clone(),
            author_id: id::<ParticipantId>("participant-owner"),
            device_id: id::<DeviceId>("device-owner"),
            created_at: 1,
            parent_event_ids: Vec::new(),
            snapshot_id: None,
        },
        body: ReviewEventBody::CommentCreated {
            thread_id: "thread-cli".to_owned(),
            anchor,
            body: "Make this concrete".to_owned(),
        },
        auth: EventAuth {
            signature: "sig".to_owned(),
            signing_key_id: "key".to_owned(),
        },
    };
    store.append_event(&room_id, &event).expect("event");
    store
        .set_feedback_mark(&room_id, "thread-cli", true, 2)
        .expect("mark");
    (tmp, path)
}

#[test]
fn feedback_snapshot_runs_offline_in_text_and_json_modes() {
    let (tmp, path) = fixture();
    let binary = env!("CARGO_BIN_EXE_attn");
    let json = Command::new(binary)
        .args([
            "feedback",
            path.to_str().expect("utf8 path"),
            "--json",
            "--attn-home",
            tmp.path().to_str().expect("utf8 home"),
        ])
        .output()
        .expect("run JSON feedback");
    assert!(
        json.status.success(),
        "{}",
        String::from_utf8_lossy(&json.stderr)
    );
    let snapshot: FeedbackSnapshot = serde_json::from_slice(&json.stdout).expect("snapshot JSON");
    assert_eq!(snapshot.freshness, FeedbackFreshness::PersistedLocal);
    assert_eq!(snapshot.feedback.len(), 1);
    assert_eq!(snapshot.feedback[0].id, "room-cli-feedback:thread-cli");

    let text = Command::new(binary)
        .args([
            "feedback",
            path.to_str().expect("utf8 path"),
            "--attn-home",
            tmp.path().to_str().expect("utf8 home"),
        ])
        .output()
        .expect("run text feedback");
    assert!(text.status.success());
    let text = String::from_utf8(text.stdout).expect("utf8 output");
    assert!(text.contains("# attn feedback v1"));
    assert!(text.contains("Make this concrete"));
}

#[test]
fn feedback_watch_fails_actionably_without_a_daemon() {
    let (tmp, path) = fixture();
    let output = Command::new(env!("CARGO_BIN_EXE_attn"))
        .args([
            "feedback",
            path.to_str().expect("utf8 path"),
            "--watch",
            "--attn-home",
            tmp.path().to_str().expect("utf8 home"),
        ])
        .output()
        .expect("run watch");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires a running attn daemon"));
}
