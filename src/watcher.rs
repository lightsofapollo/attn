use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::event_loop::EventLoopProxy;

/// Sent from background threads to wake the event loop.
// The `Review` variant wraps a `ReviewUpdate` (~816B via `EventImported`); these
// are sent one at a time to wake the event loop and consumed immediately, so
// boxing would only add indirection without a meaningful size win.
#[allow(clippy::large_enum_variant)]
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
    /// A `ReviewManager` produced an update (room status, imported event,
    /// snapshot, etc.) that must be forwarded into the webview via
    /// `window.__attn__.review*` callbacks.
    ///
    /// Per `planning/collab/amendments.md` §Codebase Corrections: the
    /// `ReviewManager` integrates into the *existing* event loop rather than
    /// spinning up a separate runtime. See issue attn-nnj.2.8.
    Review(crate::review::manager::ReviewUpdate),
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

                // WSL / atomic-save guard (attn-134): editors and the 9p/drvfs
                // bridge frequently report a Remove for an atomic save
                // (write-temp + rename-over, or delete+recreate) even though the
                // file is still present. A bare Remove for the *active* file
                // would close the open document. If every path in a Remove event
                // still exists on disk, it wasn't really removed — treat it as a
                // Modify (reload) instead of a Remove (close / drop from tree).
                let change_kind = reclassify_atomic_save_remove(change_kind, &filtered_paths);

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

/// WSL/atomic-save guard (attn-134). A `Remove` whose paths all still exist on
/// disk is an atomic-save artifact (rename-over / delete+recreate), not a real
/// deletion — reclassify it to `Modify` so the open file reloads instead of
/// closing (and the file stays in the tree). A genuine deletion (path gone)
/// stays a `Remove`. Non-Remove kinds pass through unchanged.
fn reclassify_atomic_save_remove(kind: FsChangeKind, paths: &[PathBuf]) -> FsChangeKind {
    if kind == FsChangeKind::Remove && !paths.is_empty() && paths.iter().all(|p| p.exists()) {
        FsChangeKind::Modify
    } else {
        kind
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
    fn atomic_save_remove_on_existing_file_reclassifies_to_modify() {
        // WSL atomic-save (attn-134): a Remove for a file that still exists is a
        // rename-over/delete+recreate artifact, not a deletion — reload, don't close.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("doc.md");
        std::fs::write(&path, "# still here\n").expect("write");
        let paths = vec![path];
        assert_eq!(
            reclassify_atomic_save_remove(FsChangeKind::Remove, &paths),
            FsChangeKind::Modify,
            "Remove for an existing file must become Modify"
        );
    }

    #[test]
    fn genuine_remove_of_missing_file_stays_remove() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = vec![dir.path().join("gone.md")]; // never created
        assert_eq!(
            reclassify_atomic_save_remove(FsChangeKind::Remove, &paths),
            FsChangeKind::Remove,
            "Remove for a truly-missing file must stay Remove"
        );
    }

    #[test]
    fn non_remove_kinds_pass_through_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("doc.md");
        std::fs::write(&path, "x").expect("write");
        let paths = vec![path];
        for kind in [FsChangeKind::Create, FsChangeKind::Modify, FsChangeKind::Rename] {
            assert_eq!(reclassify_atomic_save_remove(kind, &paths), kind);
        }
    }

    #[test]
    fn mixed_remove_with_one_missing_path_stays_remove() {
        // If any path is genuinely gone, it's a real deletion — don't downgrade.
        let dir = tempfile::tempdir().expect("tempdir");
        let present = dir.path().join("a.md");
        std::fs::write(&present, "x").expect("write");
        let paths = vec![present, dir.path().join("b-gone.md")];
        assert_eq!(
            reclassify_atomic_save_remove(FsChangeKind::Remove, &paths),
            FsChangeKind::Remove
        );
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
