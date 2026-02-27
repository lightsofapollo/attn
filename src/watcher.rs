use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    pub rx: mpsc::Receiver<()>,
}

impl FileWatcher {
    pub fn new(path: &Path) -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::channel();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_)
                ) {
                    let _ = tx.send(());
                }
            }
        })?;

        let watch_path = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };

        watcher.watch(watch_path, RecursiveMode::NonRecursive)?;

        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }
}
