use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tao::event_loop::EventLoopProxy;

/// Sent from background threads to wake the event loop.
#[derive(Debug)]
pub enum UserEvent {
    /// The watched file was modified on disk.
    FileChanged,
    /// Another attn invocation wants to open a new path.
    OpenPath(PathBuf),
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
    _watcher: RecommendedWatcher,
}

/// Debounce interval — ignore duplicate events within this window.
const DEBOUNCE_MS: u128 = 100;

impl FileWatcher {
    /// Start watching `path` (or its parent directory if it's a file).
    /// Sends `UserEvent::FileChanged` through the proxy when a relevant
    /// change is detected, with basic debouncing.
    pub fn new(path: &Path, proxy: EventLoopProxy<UserEvent>) -> Result<Self, notify::Error> {
        let watched_file: Option<PathBuf> = if path.is_file() {
            Some(path.to_path_buf())
        } else {
            None
        };

        let last_event = Arc::new(Mutex::new(
            Instant::now() - std::time::Duration::from_secs(1),
        ));

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    return;
                }

                // If we're watching a specific file, filter to only that file
                if let Some(ref target) = watched_file {
                    let dominated = event.paths.iter().any(|p| p == target);
                    if !dominated {
                        return;
                    }
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

                let _ = proxy.send_event(UserEvent::FileChanged);
            }
        })?;

        let watch_path = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };

        watcher.watch(watch_path, RecursiveMode::NonRecursive)?;

        Ok(Self { _watcher: watcher })
    }
}
