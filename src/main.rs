mod daemon;
mod files;
mod ipc;
mod markdown;
mod projects;
#[cfg(all(not(feature = "production"), target_os = "macos"))]
mod screenshot;
mod watcher;

use anyhow::{Context, Result, bail};
use clap::Parser;
use percent_encoding::percent_decode_str;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tao::event::{ElementState, Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::keyboard::{KeyCode, ModifiersState};
use tao::window::WindowBuilder;
use watcher::UserEvent;
use wry::WebViewBuilder;

#[derive(Parser, Debug)]
#[command(name = "attn", about = "A beautiful markdown viewer")]
struct Cli {
    /// File or directory to view
    #[arg(default_value = ".")]
    path: PathBuf,

    /// Open in skim mode (headers + first lines only)
    #[arg(long)]
    skim: bool,

    /// Force dark mode
    #[arg(long)]
    dark: bool,

    /// Force light mode
    #[arg(long)]
    light: bool,

    /// Print task progress to stdout (no window)
    #[arg(long)]
    status: bool,

    /// Output structured plan data as JSON (no window)
    #[arg(long)]
    json: bool,

    /// Validate file references and report stale sections (no window)
    #[arg(long)]
    check: bool,

    /// Don't fork to background (for development)
    #[arg(long)]
    no_fork: bool,

    /// Take a screenshot of the daemon window and print the path
    #[cfg(not(feature = "production"))]
    #[arg(long)]
    screenshot: bool,

    /// Print daemon info (binary path, PID)
    #[arg(long)]
    info: bool,

    /// Evaluate JavaScript in the daemon webview and print the result
    #[arg(long)]
    eval: Option<String>,

    /// Click an element by CSS selector or text= prefix
    #[arg(long)]
    click: Option<String>,

    /// Wait for an element to appear by CSS selector or text= prefix
    #[arg(long)]
    wait_for: Option<String>,

    /// Query elements by CSS selector or text= prefix (returns JSON)
    #[arg(long)]
    query: Option<String>,

    /// Fill a form field: --fill <SELECTOR> <VALUE>
    #[arg(long, num_args = 2, value_names = ["SELECTOR", "VALUE"])]
    fill: Option<Vec<String>>,

    /// Timeout in milliseconds for --wait-for (default: 5000)
    #[arg(long, default_value_t = 5000)]
    timeout: u64,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("attn: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let path = cli
        .path
        .canonicalize()
        .with_context(|| format!("cannot open '{}'", cli.path.display()))?;

    // Daemon command modes — talk to running daemon
    #[cfg(not(feature = "production"))]
    if cli.screenshot {
        let path = daemon::send_screenshot()?;
        println!("{path}");
        return Ok(());
    }
    if let Some(js) = &cli.eval {
        let result = daemon::send_eval(js)?;
        println!("{result}");
        return Ok(());
    }
    if let Some(selector) = &cli.click {
        let result = daemon::send_interact(daemon::InteractAction::Click {
            selector: selector.clone(),
        })?;
        return print_interact_result(&result);
    }
    if let Some(selector) = &cli.wait_for {
        let result = daemon::send_interact(daemon::InteractAction::WaitFor {
            selector: selector.clone(),
            timeout_ms: cli.timeout,
        })?;
        return print_interact_result(&result);
    }
    if let Some(selector) = &cli.query {
        let result = daemon::send_interact(daemon::InteractAction::Query {
            selector: selector.clone(),
        })?;
        return print_interact_result(&result);
    }
    if let Some(args) = &cli.fill {
        let result = daemon::send_interact(daemon::InteractAction::Fill {
            selector: args[0].clone(),
            value: args[1].clone(),
        })?;
        return print_interact_result(&result);
    }
    if cli.info {
        let info = daemon::send_info()?;
        println!("{}", info.binary);
        println!("pid: {}", info.pid);
        if let Some(wid) = info.window_id {
            println!("window_id: {wid}");
        }
        return Ok(());
    }

    // Headless modes — stdout only, no window
    if cli.status || cli.json || cli.check {
        if !path.is_file() {
            bail!("headless modes require a file path");
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read '{}'", path.display()))?;

        let result = markdown::render(&content);

        if cli.json {
            let json = serde_json::to_string_pretty(&result.structure)
                .context("failed to serialize plan structure")?;
            println!("{json}");
        } else if cli.status {
            let s = &result.structure;
            let total = s.tasks.len();
            let done = s.tasks.iter().filter(|t| t.checked).count();
            println!("{}: {}/{} tasks complete", path.display(), done, total);
        } else if cli.check {
            let s = &result.structure;
            println!("File refs found:");
            for r in &s.file_refs {
                let exists = PathBuf::from(r).exists();
                println!("  {} {}", if exists { "ok" } else { "MISSING" }, r);
            }
        }
        return Ok(());
    }

    // If binary has changed since the running daemon started, kill and replace it
    daemon::replace_stale_daemon()?;

    // Try to connect to an existing daemon — if successful, send path and exit
    let path_str = path.to_string_lossy().to_string();
    if daemon::try_send_to_existing(&path_str)? {
        return Ok(());
    }

    // No existing daemon — fork to background (unless --no-fork)
    daemon::maybe_fork(cli.no_fork)?;

    // Record our binary fingerprint so future invocations can detect staleness
    daemon::write_fingerprint()?;

    // We are now the daemon process
    run_daemon(cli, path)
}

fn run_daemon(cli: Cli, path: PathBuf) -> Result<()> {
    // Read file tree for the sidebar
    let (tree_root, file_tree, initial_ui_path) = project_view_for_path(&path);
    let file_tree_nodes = count_tree_nodes(&file_tree);
    let file_tree_json = serde_json::to_string(&file_tree).unwrap_or_default();
    eprintln!(
        "attn: startup tree root={} nodes={} json_bytes={}",
        tree_root.display(),
        file_tree_nodes,
        file_tree_json.len()
    );
    let project_registry = update_active_project_registry(&tree_root);

    let initial_structure = markdown::PlanStructure::default();
    let (initial_mtime_ms, initial_bytes) = content_metadata_for_path(&initial_ui_path);

    // Determine theme
    let theme = if cli.dark {
        "dark"
    } else if cli.light {
        "light"
    } else {
        "light"
    };
    let diag_mode = diag_mode_from_env();

    let init_payload_json = serde_json::json!({
        "markdown": "",
        "structure": &initial_structure,
        "filePath": initial_ui_path.to_string_lossy(),
        "rootPath": tree_root.to_string_lossy(),
        "fileTree": &file_tree,
        "knownProjects": &project_registry.known_projects,
        "activeProjectPath": project_registry.active_project,
        "theme": theme,
        "diagMode": diag_mode,
        "contentMtimeMs": initial_mtime_ms,
        "contentBytes": initial_bytes,
    })
    .to_string();
    let page_html = build_page_html(&init_payload_json, theme);
    eprintln!("attn: startup page_html_bytes={}", page_html.len());
    let dev_server_url = dev_server_url_from_env();
    let dev_server_origin = dev_server_url.as_deref().and_then(origin_from_url);
    let initialization_script =
        build_initialization_script(dev_server_url.is_some(), &init_payload_json);

    if let Some(url) = &dev_server_url {
        eprintln!("attn: loading UI from Vite dev server at {url}");
    } else {
        eprintln!("attn: loading embedded UI");
    }

    // Create window and webview with typed event loop
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    // Decide Dock behavior on macOS:
    // - default is Regular (shows Dock icon)
    // - env override:
    //   - ATTN_NO_DOCK_ICON=1|true|yes|on forces Accessory
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::EventLoopExtMacOS;
        event_loop.set_activation_policy(macos_activation_policy());
        set_macos_app_icon();
    }

    // Start the unix socket listener for incoming paths
    let _socket_cleanup = daemon::start_listener(event_loop.create_proxy())?;
    let watcher_proxy = event_loop.create_proxy();

    // Start recursive file watcher for the current project root.
    let mut file_watcher = {
        match watcher::FileWatcher::new(&tree_root, watcher_proxy.clone()) {
            Ok(fw) => Some(fw),
            Err(e) => {
                eprintln!("attn: could not watch project tree: {e}");
                None
            }
        }
    };

    let mut window_builder = WindowBuilder::new()
        .with_title("attn")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 720.0));

    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowBuilderExtMacOS;
        window_builder = window_builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true);
    }

    let window = window_builder
        .build(&event_loop)
        .context("failed to create window")?;

    // Shared state for the IPC handler
    let app_state = Arc::new(Mutex::new(ipc::AppState {
        file_path: initial_ui_path.clone(),
    }));
    let ipc_state = Arc::clone(&app_state);
    let ipc_proxy = event_loop.create_proxy();

    let mut webview_builder = WebViewBuilder::new()
        .with_initialization_script(&initialization_script)
        .with_ipc_handler(move |msg| {
            ipc::handle_message(msg.body(), &ipc_state, &ipc_proxy);
        })
        .with_navigation_handler(move |url| {
            let is_dev_server_url = dev_server_origin
                .as_deref()
                .is_some_and(|origin| url.starts_with(origin));
            if url.starts_with("data:") || url.starts_with("about:") || url.starts_with("attn:") {
                true
            } else if is_dev_server_url {
                true
            } else {
                let _ = open::that(&url);
                false
            }
        })
            .with_custom_protocol("attn".to_string(), move |_webview_id, request| {
            let uri = request.uri().to_string();
            // URI format: attn://localhost/absolute/path/to/file
            let path = uri
                .strip_prefix("attn://localhost")
                .or_else(|| uri.strip_prefix("attn://"))
                .unwrap_or(&uri);

            let path = percent_decode_str(path).decode_utf8_lossy();
            let file_path = std::path::Path::new(path.as_ref());

            match std::fs::read(file_path) {
                Ok(bytes) => {
                    let mime = mime_from_extension(file_path);
                    wry::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes.into())
                        .unwrap()
                }
                Err(_) => wry::http::Response::builder()
                    .status(404)
                    .body(Vec::new().into())
                    .unwrap(),
            }
        })
        .with_devtools(cfg!(not(feature = "production")));

    if let Some(url) = dev_server_url.as_deref() {
        webview_builder = webview_builder.with_url(url);
    } else {
        webview_builder = webview_builder.with_html(&page_html);
    }

    let webview = webview_builder
        .build(&window)
        .context("failed to create webview")?;
    eprintln!("attn: webview initialized");

    let mut current_tree_root = tree_root.clone();

    let mut modifiers = ModifiersState::default();
    eprintln!("attn: event loop running");

    // Run event loop
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Socket cleanup happens via Drop on _socket_cleanup
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                event: WindowEvent::ModifiersChanged(new_modifiers),
                ..
            } => {
                modifiers = new_modifiers;
            }
            Event::WindowEvent {
                event: WindowEvent::KeyboardInput { event, .. },
                ..
            } => {
                #[cfg(debug_assertions)]
                {
                    if event.state == ElementState::Pressed && !event.repeat {
                        let open_shortcut = event.physical_key == KeyCode::F12
                            || (event.physical_key == KeyCode::KeyI
                                && modifiers.super_key()
                                && modifiers.alt_key());
                        if open_shortcut {
                            webview.open_devtools();
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::FsChanged(changed_paths)) => {
                if changed_paths.is_empty() {
                    return;
                }

                let mut dedup = HashSet::new();
                let changed_paths: Vec<String> = changed_paths
                    .into_iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .filter(|path| dedup.insert(path.clone()))
                    .collect();

                let active_path = app_state.lock().ok().map(|state| state.file_path.clone());
                let active_path_str = active_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default();
                let active_changed = !active_path_str.is_empty()
                    && changed_paths.iter().any(|path| path == &active_path_str);

                let include_tree = changed_paths.iter().any(|path| path != &active_path_str);
                let mut payload = serde_json::Map::new();
                payload.insert("changedPaths".to_string(), serde_json::json!(changed_paths));

                if include_tree {
                    payload.insert(
                        "fileTree".to_string(),
                        serde_json::json!(files::read_tree(&current_tree_root)),
                    );
                }

                if active_changed {
                    let (content_mtime_ms, content_bytes) = active_path
                        .as_ref()
                        .map(|path| content_metadata_for_path(path))
                        .unwrap_or((None, None));
                    payload.insert("filePath".to_string(), serde_json::json!(active_path_str));
                    payload.insert("contentMtimeMs".to_string(), serde_json::json!(content_mtime_ms));
                    payload.insert("contentBytes".to_string(), serde_json::json!(content_bytes));
                }

                let js = format!(
                    "window.__attn__.updateContent({});",
                    serde_json::Value::Object(payload)
                );
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Screenshot(tx)) => {
                #[cfg(all(not(feature = "production"), target_os = "macos"))]
                {
                    use wry::WebViewExtMacOS;
                    let wk_webview = webview.webview();
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let screenshot_path = format!("/tmp/attn-screenshot-{timestamp}.png");

                    crate::screenshot::take_snapshot(&wk_webview, &screenshot_path, tx);
                }
                #[cfg(not(all(not(feature = "production"), target_os = "macos")))]
                {
                    let _ = tx.send(String::new());
                }
            }
            Event::UserEvent(UserEvent::Info(tx)) => {
                let binary = std::env::current_exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let pid = std::process::id();
                let window_id = {
                    #[cfg(target_os = "macos")]
                    {
                        use tao::platform::macos::WindowExtMacOS;
                        let ns_window_ptr = window.ns_window();
                        let ns_window: &objc2_app_kit::NSWindow =
                            unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
                        Some(ns_window.windowNumber() as i64)
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        None
                    }
                };
                let resp = daemon::SocketResponse::Info {
                    binary,
                    pid,
                    window_id,
                };
                let _ = tx.send(serde_json::to_string(&resp).unwrap_or_default());
            }
            Event::UserEvent(UserEvent::Eval(js, tx)) => {
                let _ = webview.evaluate_script_with_callback(&js, move |result| {
                    let _ = tx.send(result);
                });
            }
            Event::UserEvent(UserEvent::OpenDevtools) => {
                #[cfg(not(feature = "production"))]
                {
                    webview.open_devtools();
                }
            }
            Event::UserEvent(UserEvent::DragWindow) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(UserEvent::OpenPath(new_path)) => {
                // Update the shared state to point to the new file
                if let Ok(mut state) = app_state.lock() {
                    state.file_path = new_path.clone();
                }

                let path_str = new_path.to_string_lossy().to_string();
                let (content_mtime_ms, content_bytes) = content_metadata_for_path(&new_path);
                let payload = serde_json::json!({
                    "structure": { "phases": [], "tasks": [], "file_refs": [] },
                    "filePath": path_str,
                    "contentMtimeMs": content_mtime_ms,
                    "contentBytes": content_bytes,
                });
                let js = format!("window.__attn__.setContent({payload});");
                let _ = webview.evaluate_script(&js);

                // Bring window to front
                window.set_focus();
            }
            Event::UserEvent(UserEvent::SwitchProject(project_path)) => {
                let (tree_root, file_tree, initial_ui_path) = project_view_for_path(&project_path);
                let project_registry = update_active_project_registry(&tree_root);
                current_tree_root = tree_root.clone();

                if let Some(watcher) = file_watcher.as_mut() {
                    if let Err(e) = watcher.update_root(&current_tree_root) {
                        eprintln!(
                            "attn: could not retarget watcher to {}: {}",
                            current_tree_root.display(),
                            e
                        );
                    }
                } else {
                    match watcher::FileWatcher::new(&current_tree_root, watcher_proxy.clone()) {
                        Ok(w) => {
                            file_watcher = Some(w);
                        }
                        Err(e) => {
                            eprintln!(
                                "attn: could not start watcher for {}: {}",
                                current_tree_root.display(),
                                e
                            );
                        }
                    }
                }

                if let Ok(mut state) = app_state.lock() {
                    state.file_path = initial_ui_path.clone();
                }

                let path_str = initial_ui_path.to_string_lossy().to_string();
                let (content_mtime_ms, content_bytes) = content_metadata_for_path(&initial_ui_path);
                let payload = serde_json::json!({
                    "structure": { "phases": [], "tasks": [], "file_refs": [] },
                    "filePath": path_str,
                    "rootPath": tree_root.to_string_lossy(),
                    "fileTree": file_tree,
                    "knownProjects": project_registry.known_projects,
                    "activeProjectPath": project_registry.active_project,
                    "contentMtimeMs": content_mtime_ms,
                    "contentBytes": content_bytes,
                });
                let js = format!("window.__attn__.setContent({payload});");
                let _ = webview.evaluate_script(&js);

                window.set_focus();
            }
            _ => {}
        }
    });
}

fn project_view_for_path(path: &Path) -> (PathBuf, Vec<files::TreeNode>, PathBuf) {
    let requested = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let tree_root = projects::normalize_project_root(&requested);
    let file_tree = files::read_tree(&tree_root);
    let initial_ui_path = if requested.is_file() {
        requested
    } else {
        find_first_previewable_path(&file_tree).unwrap_or_else(|| tree_root.clone())
    };

    (tree_root, file_tree, initial_ui_path)
}

fn update_active_project_registry(tree_root: &Path) -> projects::ProjectRegistry {
    match projects::set_active_project(tree_root) {
        Ok(registry) => registry,
        Err(e) => {
            eprintln!(
                "attn: failed to persist project registry for {}: {}",
                tree_root.display(),
                e
            );
            let mut registry = projects::load_registry();
            let root = tree_root.to_string_lossy().to_string();
            if !registry.known_projects.iter().any(|entry| entry == &root) {
                registry.known_projects.insert(0, root.clone());
            }
            registry.active_project = Some(root);
            registry
        }
    }
}

fn find_first_previewable_path(nodes: &[files::TreeNode]) -> Option<PathBuf> {
    for node in nodes {
        if node.is_dir {
            if let Some(children) = &node.children
                && let Some(path) = find_first_previewable_path(children)
            {
                return Some(path);
            }
        } else if matches!(
            node.file_type,
            files::FileType::Markdown
                | files::FileType::Image
                | files::FileType::Video
                | files::FileType::Audio
        ) {
            return Some(PathBuf::from(&node.path));
        }
    }
    None
}

fn count_tree_nodes(nodes: &[files::TreeNode]) -> usize {
    let mut total = 0usize;
    for node in nodes {
        total += 1;
        if let Some(children) = &node.children {
            total += count_tree_nodes(children);
        }
    }
    total
}

fn print_interact_result(result: &daemon::InteractResult) -> Result<()> {
    match result {
        daemon::InteractResult::Ok => {
            println!("ok");
            Ok(())
        }
        daemon::InteractResult::Found { .. } => {
            let json = serde_json::to_string_pretty(result)
                .context("failed to serialize interact result")?;
            println!("{json}");
            Ok(())
        }
        daemon::InteractResult::NotFound { selector } => {
            eprintln!("not found: {selector}");
            std::process::exit(1);
        }
        daemon::InteractResult::Timeout {
            selector,
            timeout_ms,
        } => {
            eprintln!("timeout after {timeout_ms}ms waiting for: {selector}");
            std::process::exit(1);
        }
        daemon::InteractResult::Error { message } => {
            bail!("{message}");
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_activation_policy() -> tao::platform::macos::ActivationPolicy {
    use tao::platform::macos::ActivationPolicy;

    if env_truthy("ATTN_NO_DOCK_ICON") {
        return ActivationPolicy::Accessory;
    }

    ActivationPolicy::Regular
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    static ICON_BYTES: &[u8] = include_bytes!("../icons/attn.icns");

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    let icon_data = NSData::with_bytes(ICON_BYTES);
    let Some(icon_image) = NSImage::initWithData(NSImage::alloc(), &icon_data) else {
        return;
    };

    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setApplicationIconImage(Some(&icon_image));
    }
}

#[cfg(target_os = "macos")]
fn env_truthy(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

fn dev_server_url_from_env() -> Option<String> {
    #[cfg(feature = "production")]
    {
        None
    }
    #[cfg(not(feature = "production"))]
    {
        std::env::var("ATTN_DEV_SERVER_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }
}

fn origin_from_url(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let host_and_path = &url[scheme_end + 3..];
    if host_and_path.is_empty() {
        return None;
    }
    let host_end = host_and_path.find('/').unwrap_or(host_and_path.len());
    Some(format!(
        "{}://{}",
        &url[..scheme_end],
        &host_and_path[..host_end]
    ))
}

fn diag_mode_from_env() -> String {
    let raw = std::env::var("ATTN_DIAG_MODE").unwrap_or_else(|_| "full".to_string());
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "minimal" => "minimal".to_string(),
        "editor_only" | "editor-only" | "editor" => "editor_only".to_string(),
        "full" | "" => "full".to_string(),
        _ => {
            eprintln!(
                "attn: unknown ATTN_DIAG_MODE='{}' (expected full|editor_only|minimal); using full",
                raw
            );
            "full".to_string()
        }
    }
}

fn content_metadata_for_path(path: &Path) -> (Option<u64>, Option<u64>) {
    if !path.is_file() {
        return (None, None);
    }

    let Ok(metadata) = std::fs::metadata(path) else {
        return (None, None);
    };

    let bytes = Some(metadata.len());
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());

    (mtime_ms, bytes)
}

fn build_initialization_script(include_init_payload: bool, init_payload_json: &str) -> String {
    let base = r#"window.__attn_queue__ = window.__attn_queue__ || [];
if (!window.__attn__) {
    window.__attn__ = {
        setContent: data => window.__attn_queue__.push({ kind: 'set', data }),
        updateContent: data => window.__attn_queue__.push({ kind: 'update', data }),
    };
}

const __attnMaxMessageLength = 32768;
const __attnTrim = text => {
    if (typeof text !== 'string') return String(text ?? '');
    if (text.length <= __attnMaxMessageLength) return text;
    return text.slice(0, __attnMaxMessageLength) + '...[truncated]';
};
const __attnPost = payload => {
    try {
        window.ipc?.postMessage(JSON.stringify(payload));
    } catch (_) {}
};
const __attnStringify = value => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Error) {
        if (value.stack) return __attnTrim(String(value.stack));
        return __attnTrim(`${value.name}: ${value.message}`);
    }
    if (typeof value === 'string') return __attnTrim(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'function') {
        return `[function ${value.name || 'anonymous'}]`;
    }
    try {
        return __attnTrim(JSON.stringify(value));
    } catch (_) {}
    try {
        return __attnTrim(String(value));
    } catch (_) {
        return '[unserializable value]';
    }
};
const __attnJoinArgs = args => Array.from(args).map(__attnStringify).join(' ');

if (!window.__attn_js_bridge_installed__) {
    window.__attn_js_bridge_installed__ = true;
    window.addEventListener('error', event => {
        const err = event.error;
        __attnPost({
            type: 'js_error',
            message: __attnTrim(event.message || __attnStringify(err)),
            source: event.filename || 'window.onerror',
            line: event.lineno || 0,
            column: event.colno || 0,
            stack: err && err.stack ? __attnTrim(String(err.stack)) : undefined
        });
    });

    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason;
        __attnPost({
            type: 'js_error',
            message: __attnTrim(__attnStringify(reason)),
            source: 'unhandledrejection',
            line: 0,
            column: 0,
            stack: reason && reason.stack ? __attnTrim(String(reason.stack)) : undefined
        });
    });
}"#;

    if include_init_payload {
        format!("window.__attn_init__ = {init_payload_json};\n{base}")
    } else {
        base.to_string()
    }
}

fn mime_from_extension(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html",
        Some("txt" | "md") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The Svelte app, built by Vite into a single self-contained HTML file.
/// Embedded at compile time via `include_str!`.
const APP_HTML: &str = include_str!("../web/dist/index.html");

fn build_page_html(
    init_payload_json: &str,
    theme: &str,
) -> String {
    let init_script = format!(
        r#"<script>window.__attn_init__ = {init_payload_json};</script>"#,
        init_payload_json = init_payload_json,
    );

    // Inject into the template
    APP_HTML
        .replace("<!-- INIT_SCRIPT -->", &init_script)
        .replace("data-theme=\"system\"", &format!("data-theme=\"{theme}\""))
        .replace("data-theme=\"light\"", &format!("data-theme=\"{theme}\""))
}
