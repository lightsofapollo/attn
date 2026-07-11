//! Native review notification batching.
//!
//! Only freshly verified remote events enter this module.  Event plaintext is
//! deliberately reduced to a kind and a local display filename before it
//! crosses the platform-notification boundary.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use crate::review::ids::RoomId;
use crate::review::model::ReviewEventBody;
use crate::review::store::ReviewStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewNotificationKind {
    Comment,
    Suggestion,
    Verdict,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ReviewNotification {
    pub room_id: RoomId,
    pub title: String,
    pub body: String,
    pub deep_link: String,
}

/// Parse the content-free native notification route. This accepts only a
/// plain local room id: capability-bearing join links must stay on the normal
/// invite path and must never be interpreted as a notification click.
pub(crate) fn room_id_from_deep_link(uri: &str) -> Option<String> {
    let room_id = uri.strip_prefix("attn://review/")?;
    if room_id.is_empty() || room_id.contains(['/', '?', '#']) {
        return None;
    }
    Some(room_id.to_string())
}

/// Preserve the notification target until the Svelte review store has
/// hydrated, then select it through the production store bridge. JSON
/// encoding prevents an untrusted URI segment from becoming script source.
pub(crate) fn focus_script(room_id: &str) -> String {
    let room_id_json = serde_json::to_string(room_id).unwrap_or_else(|_| "null".into());
    format!(
        "window.__attn_pending_review_focus__ = {room_id_json}; if (window.__attn_review_store__?.selectRoom({room_id_json})) {{ delete window.__attn_pending_review_focus__; }}"
    )
}

pub trait ReviewNotificationSink: Send + Sync + 'static {
    fn post(&self, notification: ReviewNotification);
}

#[derive(Default)]
pub struct NoopNotificationSink;

impl ReviewNotificationSink for NoopNotificationSink {
    fn post(&self, _notification: ReviewNotification) {}
}

#[derive(Debug, Clone, Copy, Default)]
struct ViewState {
    room_visible: bool,
    window_focused: bool,
}

#[derive(Debug)]
struct Incoming {
    room_id: RoomId,
    kind: ReviewNotificationKind,
    file_display: String,
}

#[derive(Debug)]
struct Batch {
    room_id: RoomId,
    comments: u32,
    suggestions: u32,
    verdicts: u32,
    file_display: String,
    deadline: Instant,
}

impl Batch {
    fn new(item: Incoming, deadline: Instant) -> Self {
        let mut batch = Self {
            room_id: item.room_id,
            comments: 0,
            suggestions: 0,
            verdicts: 0,
            file_display: safe_file_display(&item.file_display),
            deadline,
        };
        batch.fold(item.kind);
        batch
    }

    fn fold(&mut self, kind: ReviewNotificationKind) {
        match kind {
            ReviewNotificationKind::Comment => self.comments = self.comments.saturating_add(1),
            ReviewNotificationKind::Suggestion => {
                self.suggestions = self.suggestions.saturating_add(1)
            }
            ReviewNotificationKind::Verdict => self.verdicts = self.verdicts.saturating_add(1),
        }
    }

    fn finish(self) -> ReviewNotification {
        let total = self
            .comments
            .saturating_add(self.suggestions)
            .saturating_add(self.verdicts);
        let noun = if self.suggestions == 0 && self.verdicts == 0 {
            plural(total, "comment", "comments")
        } else if self.comments == 0 && self.verdicts == 0 {
            plural(total, "suggestion", "suggestions")
        } else if self.comments == 0 && self.suggestions == 0 {
            plural(total, "verdict", "verdicts")
        } else {
            plural(total, "review update", "review updates")
        };
        ReviewNotification {
            deep_link: format!("attn://review/{}", self.room_id.as_str()),
            room_id: self.room_id,
            title: "attn review".to_string(),
            body: format!("{total} new {noun} on {}", self.file_display),
        }
    }
}

fn plural<'a>(count: u32, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 { singular } else { plural }
}

/// Prevent paths, event text, and control characters from entering an OS
/// notification. Callers normally pass a local filename; this is a final
/// fail-closed boundary.
fn safe_file_display(value: &str) -> String {
    let leaf = std::path::Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("shared document");
    let clean: String = leaf
        .chars()
        .filter(|ch| !ch.is_control())
        .take(80)
        .collect();
    if clean.trim().is_empty() {
        "shared document".to_string()
    } else {
        clean
    }
}

/// Process-lifetime coordinator. It does not inspect historical events, so a
/// daemon restart cannot replay old OS notifications.
pub struct ReviewNotifications {
    store: Arc<ReviewStore>,
    views: Arc<Mutex<HashMap<RoomId, ViewState>>>,
    tx: mpsc::Sender<Incoming>,
}

impl ReviewNotifications {
    pub fn new(
        store: Arc<ReviewStore>,
        sink: Arc<dyn ReviewNotificationSink>,
        debounce: Duration,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let views = Arc::new(Mutex::new(HashMap::new()));
        let coordinator = Arc::new(Self {
            store: Arc::clone(&store),
            views: Arc::clone(&views),
            tx,
        });
        std::thread::Builder::new()
            .name("review-notifications".to_string())
            .spawn(move || worker(rx, sink, debounce, store, views))
            .expect("spawn review notification worker");
        coordinator
    }

    pub fn set_view_state(&self, room_id: RoomId, room_visible: bool, window_focused: bool) {
        if let Ok(mut views) = self.views.lock() {
            if room_visible {
                // A single webview can display only one review room. The
                // frontend reports the newly selected room, so invalidate the
                // previous selection here instead of relying on a racy second
                // IPC for it.
                for view in views.values_mut() {
                    view.room_visible = false;
                }
            }
            views.insert(
                room_id,
                ViewState {
                    room_visible,
                    window_focused,
                },
            );
        }
    }

    pub fn enqueue(
        &self,
        room_id: RoomId,
        kind: ReviewNotificationKind,
        file_display: impl Into<String>,
    ) {
        let focused = self
            .views
            .lock()
            .ok()
            .and_then(|views| views.get(&room_id).copied())
            .is_some_and(|view| view.room_visible && view.window_focused);
        if focused {
            return;
        }
        match self.store.notification_muted(&room_id) {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(
                    room_id = room_id.as_str(),
                    "could not read notification mute: {error:#}"
                );
                return;
            }
        }
        let _ = self.tx.send(Incoming {
            room_id,
            kind,
            file_display: file_display.into(),
        });
    }
}

fn worker(
    rx: mpsc::Receiver<Incoming>,
    sink: Arc<dyn ReviewNotificationSink>,
    debounce: Duration,
    store: Arc<ReviewStore>,
    views: Arc<Mutex<HashMap<RoomId, ViewState>>>,
) {
    let mut batches: HashMap<RoomId, Batch> = HashMap::new();
    loop {
        let timeout = batches
            .values()
            .map(|batch| batch.deadline.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(60));
        match rx.recv_timeout(timeout) {
            Ok(item) => {
                let deadline = Instant::now() + debounce;
                batches
                    .entry(item.room_id.clone())
                    .and_modify(|batch| {
                        batch.fold(item.kind);
                        // A burst is a trailing-edge debounce.
                        batch.deadline = deadline;
                    })
                    .or_insert_with(|| Batch::new(item, deadline));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        let ready: Vec<RoomId> = batches
            .iter()
            .filter(|(_, batch)| batch.deadline <= now)
            .map(|(room_id, _)| room_id.clone())
            .collect();
        for room_id in ready {
            if let Some(batch) = batches.remove(&room_id) {
                let focused = views
                    .lock()
                    .ok()
                    .and_then(|states| states.get(&room_id).copied())
                    .is_some_and(|view| view.room_visible && view.window_focused);
                let muted = store.notification_muted(&room_id).unwrap_or(true);
                if !focused && !muted {
                    sink.post(batch.finish());
                }
            }
        }
    }
}

/// Reduce an authenticated review event to the only metadata allowed to
/// cross into the OS notification layer.
pub(crate) fn summary_for_event(
    store: &ReviewStore,
    room_id: &RoomId,
    body: &ReviewEventBody,
) -> (ReviewNotificationKind, String) {
    let (kind, file_id) = match body {
        ReviewEventBody::CommentCreated { anchor, .. } => (
            ReviewNotificationKind::Comment,
            Some(anchor.file_id.clone()),
        ),
        ReviewEventBody::SuggestionCreated { anchor, .. } => (
            ReviewNotificationKind::Suggestion,
            Some(anchor.file_id.clone()),
        ),
        ReviewEventBody::SuggestionAccepted { suggestion_id, .. }
        | ReviewEventBody::SuggestionRejected { suggestion_id, .. } => {
            let file_id = store.iter_events(room_id).ok().and_then(|events| {
                events.into_iter().find_map(|entry| match entry.ok()?.body {
                    ReviewEventBody::SuggestionCreated {
                        suggestion_id: candidate,
                        anchor,
                        ..
                    } if candidate == *suggestion_id => Some(anchor.file_id),
                    _ => None,
                })
            });
            (ReviewNotificationKind::Verdict, file_id)
        }
        _ => (ReviewNotificationKind::Comment, None),
    };
    let display = file_id
        .as_ref()
        .and_then(|file_id| {
            store.load_bindings(room_id).ok().and_then(|bindings| {
                bindings
                    .get(file_id)
                    .map(|binding| binding.absolute_path.clone())
            })
        })
        .or_else(|| {
            store.iter_events(room_id).ok().and_then(|events| {
                events.into_iter().fold(None, |latest, entry| {
                    match entry.ok().map(|event| event.body) {
                        Some(ReviewEventBody::SnapshotCreated {
                            owner_display_path: Some(path),
                            ..
                        }) => Some(path),
                        _ => latest,
                    }
                })
            })
        })
        .unwrap_or_else(|| "shared document".to_string());
    (kind, display)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<ReviewNotification>>);
    impl ReviewNotificationSink for RecordingSink {
        fn post(&self, notification: ReviewNotification) {
            self.0.lock().expect("sink lock").push(notification);
        }
    }

    fn room(value: &str) -> RoomId {
        serde_json::from_value(serde_json::Value::String(value.to_string())).expect("room id")
    }

    #[test]
    fn burst_folds_per_room_without_plaintext_or_path_leakage() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("store"));
        let sink = Arc::new(RecordingSink::default());
        let notifications =
            ReviewNotifications::new(store, sink.clone(), Duration::from_millis(20));
        for _ in 0..3 {
            notifications.enqueue(
                room("room-a"),
                ReviewNotificationKind::Comment,
                "/secret/plan.md",
            );
        }
        std::thread::sleep(Duration::from_millis(80));
        let posted = sink.0.lock().expect("sink lock");
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].body, "3 new comments on plan.md");
        assert!(!posted[0].body.contains("secret"));
        assert_eq!(posted[0].deep_link, "attn://review/room-a");
    }

    #[test]
    fn focused_visible_and_persisted_mute_suppress_notifications() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("store"));
        let sink = Arc::new(RecordingSink::default());
        let notifications =
            ReviewNotifications::new(store.clone(), sink.clone(), Duration::from_millis(10));
        let focused = room("room-focused");
        notifications.set_view_state(focused.clone(), true, true);
        notifications.enqueue(focused, ReviewNotificationKind::Suggestion, "doc.md");
        let muted = room("room-muted");
        store
            .set_notification_muted(&muted, true)
            .expect("persist mute");
        notifications.enqueue(muted.clone(), ReviewNotificationKind::Verdict, "doc.md");
        assert!(store.notification_muted(&muted).expect("reload mute"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(sink.0.lock().expect("sink lock").is_empty());
    }

    #[test]
    fn restart_does_not_replay_persisted_events() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("store"));
        let sink = Arc::new(RecordingSink::default());
        // Constructing a fresh coordinator intentionally has no history scan.
        let _notifications =
            ReviewNotifications::new(store, sink.clone(), Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(30));
        assert!(sink.0.lock().expect("sink lock").is_empty());
    }

    #[test]
    fn selecting_another_room_invalidates_the_previous_visible_room() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("store"));
        let sink = Arc::new(RecordingSink::default());
        let notifications =
            ReviewNotifications::new(store, sink.clone(), Duration::from_millis(10));
        let first = room("room-first");
        notifications.set_view_state(first.clone(), true, true);
        notifications.set_view_state(room("room-second"), true, true);
        notifications.enqueue(first, ReviewNotificationKind::Comment, "first.md");
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(sink.0.lock().expect("sink lock").len(), 1);
    }

    #[test]
    fn focus_or_mute_during_debounce_discards_pending_batch() {
        let tmp = TempDir::new().expect("tempdir");
        let store = Arc::new(ReviewStore::open_at(tmp.path().join("reviews")).expect("store"));
        let sink = Arc::new(RecordingSink::default());
        let notifications =
            ReviewNotifications::new(store.clone(), sink.clone(), Duration::from_millis(30));
        let focused = room("room-focus-late");
        notifications.enqueue(focused.clone(), ReviewNotificationKind::Comment, "focus.md");
        notifications.set_view_state(focused, true, true);

        let muted = room("room-mute-late");
        notifications.enqueue(muted.clone(), ReviewNotificationKind::Suggestion, "mute.md");
        store
            .set_notification_muted(&muted, true)
            .expect("mute pending batch");

        std::thread::sleep(Duration::from_millis(80));
        assert!(sink.0.lock().expect("sink lock").is_empty());
    }
}
