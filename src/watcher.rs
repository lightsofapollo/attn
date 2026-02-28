use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tao::event_loop::EventLoopProxy;

/// Sent from background threads to wake the event loop.
#[derive(Debug)]
pub enum UserEvent {
    /// One or more watched files changed on disk.
    FsChanged(Vec<PathBuf>),
    /// Another attn invocation wants to open a new path.
    OpenPath(PathBuf),
    /// Switch to a project root and refresh sidebar content.
    SwitchProject(PathBuf),
    /// Take a screenshot and send the path back through the channel.
    Screenshot(std::sync::mpsc::Sender<String>),
    /// Request daemon info (binary path, PID) and send back through the channel.
    Info(std::sync::mpsc::Sender<String>),
    /// Evaluate JavaScript and send the result back through the channel.
    Eval(String, std::sync::mpsc::Sender<String>),
    /// Open webview devtools (debug builds only).
    OpenDevtools,
    /// The user started dragging a custom title bar region.
    DragWindow,
}

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    watched_root: Option<PathBuf>,
}

/// Debounce interval — ignore duplicate events within this window.
const DEBOUNCE_MS: u128 = 100;

impl FileWatcher {
    /// Start watching `path` (directory-recursive, or parent directory for files).
    /// Sends `UserEvent::FsChanged` through the proxy with changed paths,
    /// with basic debouncing.
    pub fn new(path: &Path, proxy: EventLoopProxy<UserEvent>) -> Result<Self, notify::Error> {
        let last_event = Arc::new(Mutex::new(
            Instant::now() - std::time::Duration::from_secs(1),
        ));

        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if !matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    return;
                }

                if event.paths.is_empty() {
                    return;
                }

                // Debounce: skip if last event was within the window
                let Ok(mut last) = last_event.lock() else {
                    return;
                };
                let now = Instant::now();
                if now.duration_since(*last).as_millis() < DEBOUNCE_MS {
                    return;
                }
                *last = now;

                let _ = proxy.send_event(UserEvent::FsChanged(event.paths));
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
