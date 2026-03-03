use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::event_loop::EventLoopProxy;

/// Sent from background threads to wake the event loop.
#[derive(Debug)]
pub enum UserEvent {
    /// One or more watched files changed on disk.
    FsChanged {
        kind: FsChangeKind,
        paths: Vec<PathBuf>,
    },
    /// Another attn invocation wants to open a new path.
    OpenPath(PathBuf),
    /// Switch to a project root and refresh sidebar content.
    SwitchProject(PathBuf),
    /// Request lazy loading of a folder's direct children.
    LoadChildren(PathBuf),
    /// Request a project-wide file search for previewable files.
    SearchFiles(String),
    /// A background scan for one directory's direct children completed.
    ChildrenLoaded {
        root: PathBuf,
        parent: PathBuf,
        children: Vec<crate::files::TreeNode>,
    },
    /// Background search results are ready for the current root.
    SearchResults {
        root: PathBuf,
        query: String,
        items: Vec<crate::files::SearchResult>,
    },
    /// Take a screenshot and send the path back through the channel.
    #[cfg(debug_assertions)]
    Screenshot(std::sync::mpsc::Sender<String>),
    /// Request daemon info (binary path, PID) and send back through the channel.
    Info(std::sync::mpsc::Sender<String>),
    /// Evaluate JavaScript and send the result back through the channel.
    #[cfg(debug_assertions)]
    Eval(String, std::sync::mpsc::Sender<String>),
    /// Open webview devtools (debug builds only).
    OpenDevtools,
    /// The user started dragging a custom title bar region.
    DragWindow,
    /// Show and focus the main window.
    #[cfg(target_os = "macos")]
    ShowWindow,
    /// Hide the main window.
    #[cfg(target_os = "macos")]
    HideWindow,
    /// Increase global font scale (browser-style zoom in).
    #[cfg(target_os = "macos")]
    FontScaleIncrease,
    /// Decrease global font scale (browser-style zoom out).
    #[cfg(target_os = "macos")]
    FontScaleDecrease,
    /// Reset global font scale to default.
    #[cfg(target_os = "macos")]
    FontScaleReset,
    /// Install a CLI alias to the running app binary.
    #[cfg(target_os = "macos")]
    InstallCliAlias,
    /// Exit the app event loop.
    #[cfg(target_os = "macos")]
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsChangeKind {
    Create,
    Remove,
    Modify,
    Rename,
}

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    watched_root: Option<PathBuf>,
}

/// Debounce interval — ignore duplicate events within this window.
const DEBOUNCE_MS: u128 = 100;
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(DEBOUNCE_MS as u64);

#[derive(Debug, Clone, PartialEq, Eq)]
struct EventSignature {
    kind: FsChangeKind,
    paths: Vec<PathBuf>,
}

#[derive(Debug)]
struct DebounceState {
    last_emitted_at: Instant,
    last_signature: Option<EventSignature>,
}

fn should_ignore_component(component: &str) -> bool {
    if component.starts_with('.') {
        return true;
    }
    matches!(
        component,
        "node_modules" | "target" | "dist" | "build" | "out" | "coverage" | "__pycache__" | "venv"
    )
}

fn should_ignore_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(should_ignore_component)
    })
}

impl FileWatcher {
    /// Start watching `path` (directory-recursive, or parent directory for files).
    /// Sends `UserEvent::FsChanged` through the proxy with changed paths,
    /// with basic debouncing.
    pub fn new(path: &Path, proxy: EventLoopProxy<UserEvent>) -> Result<Self, notify::Error> {
        let debounce_state = Arc::new(Mutex::new(DebounceState {
            last_emitted_at: Instant::now() - DEBOUNCE_WINDOW,
            last_signature: None,
        }));

        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let change_kind = match &event.kind {
                    EventKind::Create(_) => FsChangeKind::Create,
                    EventKind::Remove(_) => FsChangeKind::Remove,
                    EventKind::Modify(notify::event::ModifyKind::Name(_)) => FsChangeKind::Rename,
                    EventKind::Modify(_) => FsChangeKind::Modify,
                    _ => {
                        return;
                    }
                };

                if !matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    return;
                }

                if event.paths.is_empty() {
                    return;
                }
                let filtered_paths: Vec<PathBuf> = event
                    .paths
                    .into_iter()
                    .filter(|path| !should_ignore_path(path))
                    .collect();
                if filtered_paths.is_empty() {
                    return;
                }

                let signature = EventSignature {
                    kind: change_kind,
                    paths: filtered_paths.clone(),
                };

                // Debounce only duplicate payloads; distinct events should still flow through.
                let Ok(mut state) = debounce_state.lock() else {
                    return;
                };
                let now = Instant::now();
                if !should_emit_event(&mut state, now, &signature) {
                    return;
                }

                let _ = proxy.send_event(UserEvent::FsChanged {
                    kind: change_kind,
                    paths: filtered_paths,
                });
            }
        })?;

        let mut this = Self {
            watcher,
            watched_root: None,
        };
        this.update_root(path)?;
        Ok(this)
    }

    /// Retarget the watcher to a new project root.
    pub fn update_root(&mut self, path: &Path) -> Result<(), notify::Error> {
        let watch_path = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };

        let next_root = watch_path.to_path_buf();
        if self
            .watched_root
            .as_ref()
            .is_some_and(|current| current == &next_root)
        {
            return Ok(());
        }

        if let Some(current) = &self.watched_root {
            let _ = self.watcher.unwatch(current);
        }

        self.watcher.watch(&next_root, RecursiveMode::Recursive)?;
        self.watched_root = Some(next_root);
        Ok(())
    }
}

fn should_emit_event(state: &mut DebounceState, now: Instant, next: &EventSignature) -> bool {
    let within_window = now.duration_since(state.last_emitted_at) < DEBOUNCE_WINDOW;
    let duplicate = state
        .last_signature
        .as_ref()
        .is_some_and(|last| last == next);
    if within_window && duplicate {
        return false;
    }
    state.last_emitted_at = now;
    state.last_signature = Some(next.clone());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signature(kind: FsChangeKind, path: &str) -> EventSignature {
        EventSignature {
            kind,
            paths: vec![PathBuf::from(path)],
        }
    }

    #[test]
    fn debounce_drops_only_duplicate_events_within_window() {
        let start = Instant::now();
        let mut state = DebounceState {
            last_emitted_at: start - DEBOUNCE_WINDOW,
            last_signature: None,
        };

        let create_docs = signature(FsChangeKind::Create, "/tmp/docs");
        assert!(should_emit_event(&mut state, start, &create_docs));
        assert!(!should_emit_event(
            &mut state,
            start + Duration::from_millis(50),
            &create_docs
        ));
        assert!(should_emit_event(
            &mut state,
            start + Duration::from_millis(120),
            &create_docs
        ));
    }

    #[test]
    fn debounce_allows_distinct_events_within_window() {
        let start = Instant::now();
        let mut state = DebounceState {
            last_emitted_at: start - DEBOUNCE_WINDOW,
            last_signature: None,
        };

        let create_docs = signature(FsChangeKind::Create, "/tmp/docs");
        let create_file = signature(FsChangeKind::Create, "/tmp/docs/readme.md");
        let modify_docs = signature(FsChangeKind::Modify, "/tmp/docs");

        assert!(should_emit_event(&mut state, start, &create_docs));
        assert!(should_emit_event(
            &mut state,
            start + Duration::from_millis(10),
            &create_file
        ));
        assert!(should_emit_event(
            &mut state,
            start + Duration::from_millis(20),
            &modify_docs
        ));
    }
}
