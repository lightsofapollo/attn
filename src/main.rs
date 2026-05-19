#[cfg(target_os = "macos")]
mod cli_alias;
mod daemon;
mod files;
mod ipc;
mod markdown;
mod platform;
mod projects;
mod review;
#[cfg(all(debug_assertions, target_os = "macos"))]
mod screenshot;
mod watcher;

use anyhow::{Context, Result, bail};
use clap::Parser;
use percent_encoding::percent_decode_str;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tao::event::{ElementState, Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::keyboard::{KeyCode, ModifiersState};
use tao::window::WindowBuilder;
use watcher::{FsChangeKind, UserEvent};
use wry::WebViewBuilder;

use crate::review::manager::ReviewManager;

#[derive(Parser, Debug)]
#[command(name = "attn", about = "A beautiful markdown viewer")]
struct Cli {
    /// File or directory to view
    #[arg(default_value = ".")]
    path: PathBuf,

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
    #[cfg(debug_assertions)]
    #[arg(long)]
    screenshot: bool,

    /// Print daemon info (binary path, PID)
    #[cfg(debug_assertions)]
    #[arg(long)]
    info: bool,

    /// Evaluate JavaScript in the daemon webview and print the result
    #[cfg(debug_assertions)]
    #[arg(long)]
    eval: Option<String>,

    /// Click an element by CSS selector or text= prefix
    #[cfg(debug_assertions)]
    #[arg(long)]
    click: Option<String>,

    /// Wait for an element to appear by CSS selector or text= prefix
    #[cfg(debug_assertions)]
    #[arg(long)]
    wait_for: Option<String>,

    /// Query elements by CSS selector or text= prefix (returns JSON)
    #[cfg(debug_assertions)]
    #[arg(long)]
    query: Option<String>,

    /// Fill a form field: --fill <SELECTOR> <VALUE>
    #[cfg(debug_assertions)]
    #[arg(long, num_args = 2, value_names = ["SELECTOR", "VALUE"])]
    fill: Option<Vec<String>>,

    /// Timeout in milliseconds for --wait-for (default: 5000)
    #[cfg(debug_assertions)]
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
    #[cfg(debug_assertions)]
    if cli.screenshot {
        let path = daemon::send_screenshot()?;
        println!("{path}");
        return Ok(());
    }
    #[cfg(debug_assertions)]
    {
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
    let requested_path = normalize_input_path(path.clone());
    let path_str = requested_path.to_string_lossy().to_string();
    if daemon::try_send_to_existing(&path_str)? {
        return Ok(());
    }

    // No existing daemon — fork to background (unless --no-fork)
    daemon::maybe_fork(cli.no_fork)?;

    // Record our binary fingerprint so future invocations can detect staleness
    daemon::write_fingerprint()?;

    // We are now the daemon process
    run_daemon(cli, requested_path)
}

fn run_daemon(cli: Cli, path: PathBuf) -> Result<()> {
    let requested = normalize_input_path(path);
    let tree_root = projects::normalize_project_root(&requested);
    let initial_ui_path = if requested.is_file() {
        requested
    } else {
        files::find_first_previewable_path(&tree_root).unwrap_or_else(|| tree_root.clone())
    };
    // Fast first paint: send only a shallow root snapshot; folders hydrate on demand.
    let file_tree = files::read_tree_root_snapshot(&tree_root);
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
    let theme = if cli.dark { "dark" } else { "light" };
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
    let page_html_bytes = page_html.clone().into_bytes();
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
    platform::configure_event_loop(&mut event_loop);

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

    #[allow(unused_mut)]
    let mut window_builder = WindowBuilder::new()
        .with_title("attn")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 720.0))
        .with_window_icon(load_window_icon());

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
    let _platform_ui = platform::install_system_ui(event_loop.create_proxy());

    // Shared state for the IPC handler
    //
    // ReviewStore: opened best-effort at startup so the IPC handlers
    // (attn-nnj.2.5: revision-journal persistence) have somewhere to write.
    // If the home directory is unwritable we degrade gracefully — IPC
    // saves still succeed, the revision journal just isn't persisted.
    let review_store = match crate::review::store::ReviewStore::open() {
        Ok(store) => Some(Arc::new(store)),
        Err(err) => {
            eprintln!("attn: review store unavailable, revisions will not persist: {err}");
            None
        }
    };
    // Shared with the file watcher (attn-nnj.2.6) so the watcher can
    // distinguish self-writes from external edits. The IPC `WorkingCopyService`
    // call sites and the FsChanged handler both reach into AppState for this
    // Arc so they all refer to the same tracker instance.
    let self_write_tracker = Arc::new(crate::review::watcher_state::SelfWriteTracker::new());

    // ReviewManager scaffold (issue attn-nnj.2.8): instantiate only when the
    // store is available. The manager emits `ReviewUpdate`s back into this
    // event loop via the proxy closure below, integrating with the existing
    // tao loop rather than spinning up a parallel one (per
    // `planning/collab/amendments.md` §Codebase Corrections).
    let review_manager = review_store.as_ref().map(|store| {
        let proxy = event_loop.create_proxy();
        let update_tx: crate::review::manager::UpdateSink = Box::new(move |update| {
            let _ = proxy.send_event(UserEvent::Review(update));
        });
        let working_copy =
            Arc::new(crate::review::working_copy::WorkingCopyService::new());
        Arc::new(ReviewManager::new(
            Arc::clone(store),
            working_copy,
            update_tx,
        ))
    });
    if review_manager.is_none() {
        eprintln!("attn: review manager unavailable, review commands will be no-ops");
    }

    let app_state = Arc::new(Mutex::new(ipc::AppState {
        active_path: initial_ui_path.clone(),
        active_project_root: tree_root.clone(),
        active_tab_id: None,
        review_rooms: std::collections::HashMap::new(),
        file_to_room: std::collections::HashMap::new(),
        review_store,
        self_write_tracker: Arc::clone(&self_write_tracker),
        review_manager: review_manager.clone(),
    }));

    // Prune expired entries from the self-write tracker on a slow ticker.
    // Lookups also prune lazily, so this thread is purely insurance against
    // an idle daemon accumulating entries from saves whose `FsChanged`
    // events somehow got dropped. 10 s is well above the 5 s TTL so we
    // never run faster than needed.
    {
        let tracker = Arc::clone(&self_write_tracker);
        std::thread::Builder::new()
            .name("self-write-tracker-pruner".to_string())
            .spawn(move || {
                let interval = std::time::Duration::from_secs(10);
                loop {
                    std::thread::sleep(interval);
                    tracker.prune();
                }
            })
            .ok();
    }
    let ipc_state = Arc::clone(&app_state);
    let ipc_proxy = event_loop.create_proxy();

    // Start the unix socket listener (forwards review socket commands to the
    // manager so CLI agents reach the same dispatch path as the webview IPC).
    let _socket_cleanup =
        daemon::start_listener(event_loop.create_proxy(), review_manager.clone())?;

    let custom_protocol_review_manager = review_manager.clone();
    let mut webview_builder = WebViewBuilder::new()
        .with_initialization_script(&initialization_script)
        .with_ipc_handler(move |msg| {
            ipc::handle_message(msg.body(), &ipc_state, &ipc_proxy);
        })
        .with_navigation_handler(move |url| {
            let is_dev_server_url = dev_server_origin
                .as_deref()
                .is_some_and(|origin| url.starts_with(origin));
            if url.starts_with("data:")
                || url.starts_with("about:")
                || url.starts_with("attn:")
                || is_dev_server_url
            {
                true
            } else {
                let _ = open::that(&url);
                false
            }
        })
        .with_custom_protocol("attn".to_string(), move |_webview_id, request| {
            let uri = request.uri().to_string();
            if uri == "attn://app"
                || uri == "attn://app/"
                || uri.starts_with("attn://app/index.html")
            {
                return wry::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(page_html_bytes.clone().into())
                    .unwrap();
            }

            // Route `attn://review/<roomId>...` (optionally with `#key=...`)
            // BEFORE the file-serving fallthrough — per
            // planning/collab/amendments.md §Custom `attn://` scheme handler.
            // The fragment is preserved end-to-end because the future crypto
            // layer (issue 2.8) derives the room key from it. Fragments never
            // cross the network — wry delivers the full URL in-process.
            if let Some(invite) = parse_review_invite(&uri) {
                daemon::dispatch_review_join(&invite, custom_protocol_review_manager.as_ref());
                let body = REVIEW_JOIN_ACK_HTML.as_bytes().to_vec();
                return wry::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(body.into())
                    .unwrap();
            }

            // `attn://localhost/review/...` is reserved (collides with the
            // invite path-prefix convention). Refuse explicitly so a
            // misconfigured client cannot smuggle a file-serve request that
            // looks like an invite or vice versa.
            if is_reserved_localhost_review(&uri) {
                eprintln!(
                    "attn: refusing reserved attn://localhost/review/... path: {uri}"
                );
                return wry::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(
                        b"attn://localhost/review/... is reserved; use attn://review/..."
                            .to_vec()
                            .into(),
                    )
                    .unwrap();
            }

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
        .with_devtools(cfg!(any(debug_assertions, feature = "devtools")));

    if let Some(url) = dev_server_url.as_deref() {
        webview_builder = webview_builder.with_url(url);
    } else {
        webview_builder = webview_builder.with_url("attn://app/index.html");
    }

    // On WSL, disable hardware acceleration before building the webview so
    // WebKit/Mesa never attempt EGL/GPU init (which fails without a real GPU).
    #[cfg(target_os = "linux")]
    let wsl = is_wsl();
    #[cfg(target_os = "linux")]
    if wsl {
        eprintln!("attn: WSL detected, disabling hardware acceleration");
        // SAFETY: called before spawning any threads; single-threaded at this point.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("tao default vbox");
        webview_builder
            .build_gtk(vbox)
            .context("failed to create webview")?
    };

    #[cfg(not(target_os = "linux"))]
    let webview = webview_builder
        .build(&window)
        .context("failed to create webview")?;

    // Also set the WebKit-level policy after creation as a fallback.
    #[cfg(target_os = "linux")]
    if wsl {
        use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
        use wry::WebViewExtUnix;
        let gtk_webview = webview.webview();
        if let Some(settings) = WebViewExt::settings(&gtk_webview) {
            settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
        }
    }

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
                if event.state == ElementState::Pressed && !event.repeat {
                    let mod_pressed = if cfg!(target_os = "macos") {
                        modifiers.super_key()
                    } else {
                        modifiers.control_key()
                    };

                    if mod_pressed {
                        let zoom_script = if event.physical_key == KeyCode::Equal
                            || event.physical_key == KeyCode::NumpadAdd
                        {
                            Some(
                                "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.increaseFontScale?.(); }",
                            )
                        } else if event.physical_key == KeyCode::Minus
                            || event.physical_key == KeyCode::NumpadSubtract
                        {
                            Some(
                                "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.decreaseFontScale?.(); }",
                            )
                        } else if event.physical_key == KeyCode::Digit0
                            || event.physical_key == KeyCode::Numpad0
                        {
                            Some(
                                "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.resetFontScale?.(); }",
                            )
                        } else {
                            None
                        };
                        if let Some(script) = zoom_script {
                            let _ = webview.evaluate_script(script);
                        }
                    }

                    #[cfg(debug_assertions)]
                    {
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
            Event::UserEvent(UserEvent::FsChanged { kind, paths }) => {
                if paths.is_empty() {
                    return;
                }

                // First: distinguish daemon self-writes from external edits
                // and (if external) journal a `LocalRevision`. This is
                // orthogonal to the frontend reload signal — that still
                // fires regardless of who wrote the file. attn-nnj.2.6.
                classify_and_record_changes(&paths, &app_state);

                let mut dedup = HashSet::new();
                let changed_paths: Vec<String> = paths
                    .into_iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .filter(|path| dedup.insert(path.clone()))
                    .collect();

                let active_path = app_state.lock().ok().map(|state| state.active_path.clone());
                let active_path_str = active_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default();
                let active_changed = !active_path_str.is_empty()
                    && changed_paths.iter().any(|path| path == &active_path_str);

                let mut payload = serde_json::Map::new();
                payload.insert("changedPaths".to_string(), serde_json::json!(changed_paths));

                let tree_ops = build_tree_ops(kind, &changed_paths, &current_tree_root);
                if !tree_ops.is_empty() {
                    payload.insert("treeOps".to_string(), serde_json::json!(tree_ops));
                }

                if active_changed {
                    let (content_mtime_ms, content_bytes) = active_path
                        .as_ref()
                        .map(|path| content_metadata_for_path(path))
                        .unwrap_or((None, None));
                    payload.insert("filePath".to_string(), serde_json::json!(active_path_str));
                    payload.insert(
                        "contentMtimeMs".to_string(),
                        serde_json::json!(content_mtime_ms),
                    );
                    payload.insert("contentBytes".to_string(), serde_json::json!(content_bytes));
                }

                let js = format!(
                    "window.__attn__.updateContent({});",
                    serde_json::Value::Object(payload)
                );
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::LoadChildren(path)) => {
                let requested = normalize_input_path(path);
                let parent = if requested.is_file() {
                    requested.parent().unwrap_or(&requested).to_path_buf()
                } else {
                    requested
                };
                if !parent.starts_with(&current_tree_root) {
                    return;
                }
                queue_children_refresh(&watcher_proxy, current_tree_root.clone(), parent);
            }
            Event::UserEvent(UserEvent::SearchFiles(query)) => {
                queue_search_refresh(&watcher_proxy, current_tree_root.clone(), query);
            }
            Event::UserEvent(UserEvent::ChildrenLoaded {
                root,
                parent,
                children,
            }) => {
                if root != current_tree_root {
                    return;
                }
                let payload = serde_json::json!({
                    "treePatch": {
                        "parentPath": parent.to_string_lossy(),
                        "children": children,
                    }
                });
                let js = format!("window.__attn__.updateContent({payload});");
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::SearchResults { root, query, items }) => {
                if root != current_tree_root {
                    return;
                }
                let payload = serde_json::json!({
                    "searchResults": {
                        "query": query,
                        "items": items,
                    }
                });
                let js = format!("window.__attn__.updateContent({payload});");
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Review(update)) => {
                // Route a `ReviewUpdate` from the ReviewManager into the
                // matching `window.__attn__.review*` callback (issue
                // attn-nnj.2.8). The payload is the same camelCase JSON the
                // TypeScript types in `web/src/lib/types.ts` expect.
                // `AnchorResolutionChanged` rides this same path
                // (attn-nnj.3.8) — callback_name() routes it to
                // `reviewAnchorResolution`.
                match build_review_dispatch_js(&update) {
                    Ok(js) => {
                        let _ = webview.evaluate_script(&js);
                    }
                    Err(err) => {
                        let callback = update.callback_name();
                        eprintln!(
                            "attn: failed to serialize ReviewUpdate for {callback}: {err}"
                        );
                    }
                }
            }
            #[cfg(debug_assertions)]
            Event::UserEvent(UserEvent::Screenshot(tx)) => {
                #[cfg(target_os = "macos")]
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
                #[cfg(not(target_os = "macos"))]
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
            #[cfg(debug_assertions)]
            Event::UserEvent(UserEvent::Eval(js, tx)) => {
                let _ = webview.evaluate_script_with_callback(&js, move |result| {
                    let _ = tx.send(result);
                });
            }
            Event::UserEvent(UserEvent::OpenDevtools) => {
                #[cfg(any(debug_assertions, feature = "devtools"))]
                {
                    webview.open_devtools();
                }
            }
            Event::UserEvent(UserEvent::DragWindow) => {
                let _ = window.drag_window();
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::ShowWindow) => {
                platform::activate_app();
                window.set_visible(true);
                window.set_focus();
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::HideWindow) => {
                window.set_visible(false);
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::FontScaleIncrease) => {
                let _ = webview.evaluate_script(
                    "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.increaseFontScale?.(); }",
                );
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::FontScaleDecrease) => {
                let _ = webview.evaluate_script(
                    "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.decreaseFontScale?.(); }",
                );
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::FontScaleReset) => {
                let _ = webview.evaluate_script(
                    "if (!document.querySelector('.mermaid-fullscreen-modal')) { window.__attn__?.resetFontScale?.(); }",
                );
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::InstallCliAlias) => match cli_alias::install_attn_cli_alias()
            {
                Ok(cli_alias::InstallCliAliasResult::AlreadyInstalled(path)) => {
                    eprintln!("attn: CLI alias already installed at {}", path.display());
                }
                Ok(cli_alias::InstallCliAliasResult::Installed { path, dir_on_path }) => {
                    eprintln!("attn: installed CLI alias at {}", path.display());
                    if !dir_on_path {
                        let message = format!(
                            "Installed attn at {}.\nThat directory is not on PATH for this app session.\nAdd it to your shell PATH to run `attn` from terminal.",
                            path.display()
                        );
                        if let Ok(message_json) = serde_json::to_string(&message) {
                            let js = format!("window.alert({message_json});");
                            let _ = webview.evaluate_script(&js);
                        }
                    }
                }
                Err(err) => {
                    eprintln!("attn: failed to install CLI alias: {err:#}");
                }
            },
            #[cfg(target_os = "macos")]
            Event::UserEvent(UserEvent::Quit) => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::OpenPath(new_path)) => {
                // Update the shared state to point to the new file
                if let Ok(mut state) = app_state.lock() {
                    state.active_path = new_path.clone();
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
                let requested = normalize_input_path(project_path);
                let tree_root = projects::normalize_project_root(&requested);
                let file_tree = files::read_tree_root_snapshot(&tree_root);
                let initial_ui_path = if requested.is_file() {
                    requested
                } else {
                    files::find_first_previewable_path(&tree_root).unwrap_or_else(|| tree_root.clone())
                };
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
                    state.active_path = initial_ui_path.clone();
                    state.active_project_root = tree_root.clone();
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

/// Detect if running inside Windows Subsystem for Linux.
#[cfg(target_os = "linux")]
fn is_wsl() -> bool {
    std::fs::read_to_string("/proc/version")
        .map(|v| v.contains("microsoft") || v.contains("Microsoft"))
        .unwrap_or(false)
}

fn load_window_icon() -> Option<tao::window::Icon> {
    static ICON_PNG_BYTES: &[u8] = include_bytes!("../icons/attn.png");

    let image =
        image::load_from_memory_with_format(ICON_PNG_BYTES, image::ImageFormat::Png).ok()?;
    let rgba = image.into_rgba8();
    let (width, height) = rgba.dimensions();
    tao::window::Icon::from_rgba(rgba.into_raw(), width, height).ok()
}

/// Build the JS snippet that forwards a `ReviewUpdate` into the matching
/// `window.__attn__.review*` callback. Pulled into a free function so the
/// dispatch contract is unit-testable without standing up a real webview
/// (issue attn-nnj.3.8).
fn build_review_dispatch_js(
    update: &crate::review::manager::ReviewUpdate,
) -> Result<String, serde_json::Error> {
    let callback = update.callback_name();
    let json = serde_json::to_string(update)?;
    Ok(format!(
        "window.__attn__ && window.__attn__.{callback}({json})"
    ))
}

fn queue_children_refresh(proxy: &EventLoopProxy<UserEvent>, root: PathBuf, parent: PathBuf) {
    let proxy = proxy.clone();
    std::thread::spawn(move || {
        let children = files::read_tree_root_snapshot(&parent);
        let _ = proxy.send_event(UserEvent::ChildrenLoaded {
            root,
            parent,
            children,
        });
    });
}

fn queue_search_refresh(proxy: &EventLoopProxy<UserEvent>, root: PathBuf, query: String) {
    let proxy = proxy.clone();
    std::thread::spawn(move || {
        let items = files::search_previewable_files(&root, &query, 200);
        let _ = proxy.send_event(UserEvent::SearchResults { root, query, items });
    });
}

fn build_tree_ops(
    kind: FsChangeKind,
    changed_paths: &[String],
    root: &Path,
) -> Vec<serde_json::Value> {
    let mut ops = Vec::new();
    let mut dedup = HashSet::new();

    match kind {
        FsChangeKind::Create => {
            for path in changed_paths {
                push_upsert_op(&mut ops, &mut dedup, root, Path::new(path));
            }
        }
        FsChangeKind::Remove => {
            for path in changed_paths {
                push_remove_op(&mut ops, &mut dedup, root, Path::new(path));
            }
        }
        FsChangeKind::Rename => {
            if changed_paths.len() == 2 {
                let first = Path::new(&changed_paths[0]);
                let second = Path::new(&changed_paths[1]);
                let first_exists = first.exists();
                let second_exists = second.exists();
                let (old_path, new_path) = if !first_exists && second_exists {
                    (first, second)
                } else if first_exists && !second_exists {
                    (second, first)
                } else {
                    // notify typically reports [old, new]
                    (first, second)
                };
                push_remove_op(&mut ops, &mut dedup, root, old_path);
                push_upsert_op(&mut ops, &mut dedup, root, new_path);
            } else {
                for path in changed_paths {
                    push_remove_op(&mut ops, &mut dedup, root, Path::new(path));
                }
                for path in changed_paths {
                    push_upsert_op(&mut ops, &mut dedup, root, Path::new(path));
                }
            }
        }
        FsChangeKind::Modify => {
            for path in changed_paths {
                let path = Path::new(path);
                if path.is_file() {
                    push_upsert_op(&mut ops, &mut dedup, root, path);
                }
            }
        }
    }

    ops
}

fn push_remove_op(
    ops: &mut Vec<serde_json::Value>,
    dedup: &mut HashSet<String>,
    root: &Path,
    path: &Path,
) {
    if !path.starts_with(root) {
        return;
    }
    let key = format!("remove:{}", path.display());
    if dedup.insert(key) {
        ops.push(serde_json::json!({
            "op": "remove",
            "path": path.to_string_lossy(),
        }));
    }
}

fn push_upsert_op(
    ops: &mut Vec<serde_json::Value>,
    dedup: &mut HashSet<String>,
    root: &Path,
    path: &Path,
) {
    if !path.starts_with(root) {
        return;
    }
    let Some(node) = tree_node_for_path(path) else {
        return;
    };
    let parent = path.parent().unwrap_or(root);
    if !parent.starts_with(root) {
        return;
    }
    let key = format!("upsert:{}", path.display());
    if dedup.insert(key) {
        ops.push(serde_json::json!({
            "op": "upsert",
            "parentPath": parent.to_string_lossy(),
            "node": node,
        }));
    }
}

fn tree_node_for_path(path: &Path) -> Option<files::TreeNode> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let file_type = files::detect_file_type(path);
    let is_dir = path.is_dir();
    if is_dir && !files::directory_has_previewable_descendant(path) {
        return None;
    }
    if !is_dir
        && !matches!(
            file_type,
            files::FileType::Markdown
                | files::FileType::Image
                | files::FileType::Video
                | files::FileType::Audio
        )
    {
        return None;
    }

    Some(files::TreeNode {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        children: if is_dir { Some(Vec::new()) } else { None },
        file_type,
    })
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

#[cfg(debug_assertions)]
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

fn dev_server_url_from_env() -> Option<String> {
    #[cfg(not(debug_assertions))]
    {
        None
    }
    #[cfg(debug_assertions)]
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

/// For each path in an `FsChanged` event, hash the file, ask the
/// [`SelfWriteTracker`](crate::review::watcher_state::SelfWriteTracker)
/// whether the daemon was the author, and — if it was an external write —
/// append a `LocalRevision { source: ExternalFileChange }` for any path
/// mapped to a `(room, file)` (issue attn-nnj.2.6).
///
/// This intentionally does NOT short-circuit the frontend reload signal
/// the caller still emits — the tracker is orthogonal to the UX-side
/// content refresh.
fn classify_and_record_changes(paths: &[PathBuf], app_state: &Arc<Mutex<ipc::AppState>>) {
    use crate::review::ids::ContentHash;
    use crate::review::working_copy::WorkingCopyService;

    // Snapshot the bits of AppState we need under a short-lived lock.
    let (tracker, file_map_has_entries) = {
        let Ok(state) = app_state.lock() else {
            return;
        };
        (
            state.self_write_tracker.clone(),
            !state.file_to_room.is_empty(),
        )
    };

    let svc = WorkingCopyService::new();
    for path in paths {
        // Skip non-file paths (directories, vanished files). Modify events
        // for directories are a notify-on-macos quirk we don't care about.
        if !path.is_file() {
            continue;
        }

        let hash: ContentHash = match svc.hash_path(path) {
            Ok(h) => h,
            Err(err) => {
                eprintln!(
                    "attn: watcher could not hash {} for self-write classification: {}",
                    path.display(),
                    err
                );
                continue;
            }
        };

        if tracker.consume_match(path, &hash) {
            // Self-write: the IPC handler's save flow already recorded a
            // LocalRevision via persist_revision_if_mapped. Drop on the floor.
            continue;
        }

        // External change. Only worth recording if there's at least one
        // room mapping; otherwise we'd just build and discard the
        // revision. Skip the build cost in the common (no-room) case.
        if !file_map_has_entries {
            continue;
        }

        // We don't yet have a `previous_hash` source-of-truth in AppState
        // (that arrives with attn-nnj.2.8 ReviewManager + per-file
        // last-known-hash tracking). For now, parent the revision off
        // the empty content hash — sync still works because peers
        // negotiate based on next_hash and the journal is for audit.
        let prev = crate::review::crypto::ids::content_hash(b"");
        let revision = match svc.build_external_change_revision(path, prev) {
            Ok(rev) => rev,
            Err(err) => {
                eprintln!(
                    "attn: watcher could not build external-change revision for {}: {}",
                    path.display(),
                    err
                );
                continue;
            }
        };
        crate::ipc::append_revision_if_mapped(app_state, path, &revision);
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

fn normalize_input_path(path: PathBuf) -> PathBuf {
    let absolute = absolutize_path(&path);
    absolute.canonicalize().unwrap_or(absolute)
}

fn absolutize_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path.to_path_buf(),
    }
}

fn build_initialization_script(include_init_payload: bool, init_payload_json: &str) -> String {
    let base = r#"window.__attn_native_shortcuts__ = true;
window.__attn_queue__ = window.__attn_queue__ || [];
if (!window.__attn__) {
    window.__attn__ = {
        setContent: data => window.__attn_queue__.push({ kind: 'set', data }),
        updateContent: data => window.__attn_queue__.push({ kind: 'update', data }),
        increaseFontScale: () => {},
        decreaseFontScale: () => {},
        resetFontScale: () => {},
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

/// Minimal HTML response body returned after a successful `attn://review/...`
/// match. The user normally never sees this — the wry webview consumes it
/// silently while the daemon kicks off the join — but a tiny human-readable
/// page makes the route easy to confirm via `--eval` or devtools during
/// development.
const REVIEW_JOIN_ACK_HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Joining review</title><p>Joining review room…</p>";

/// Parse an `attn://review/...` invite URI.
///
/// Returns the full original URI (including any `#key=...` fragment) when
/// the input is a review invite, otherwise `None`. We return the *original*
/// string rather than a parsed struct because the crypto layer (issue 2.8)
/// is the authoritative parser — here we only need to detect the route and
/// hand the full invite payload off intact.
///
/// Matches:
/// - `attn://review/<roomId>`
/// - `attn://review/<roomId>/...`
/// - `attn://review/<roomId>#key=...`
/// - `attn://review` (empty room id — let the join layer reject it)
fn parse_review_invite(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("attn://review")?;
    // The next character (if any) must be a path or fragment separator.
    // This guards against false positives like `attn://reviewable/...`.
    match rest.chars().next() {
        None | Some('/') | Some('#') | Some('?') => Some(uri.to_string()),
        _ => None,
    }
}

/// True if the URI targets the reserved `attn://localhost/review/...` path
/// prefix. We refuse these explicitly to prevent the file-serving fallthrough
/// from accidentally serving paths that look like invite URLs.
fn is_reserved_localhost_review(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("attn://localhost/review") else {
        return false;
    };
    matches!(rest.chars().next(), None | Some('/') | Some('#') | Some('?'))
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
/// Embedded at compile time from build output in OUT_DIR.
const APP_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/attn-index.html"));

fn build_page_html(init_payload_json: &str, theme: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_review_invite_matches_basic_room() {
        let uri = "attn://review/abc123";
        assert_eq!(parse_review_invite(uri), Some(uri.to_string()));
    }

    #[test]
    fn parse_review_invite_matches_with_path_and_fragment() {
        let uri = "attn://review/abc123/extra#key=xyz";
        assert_eq!(parse_review_invite(uri), Some(uri.to_string()));
    }

    #[test]
    fn parse_review_invite_matches_bare_review() {
        // Empty room id is left to the join layer to reject; the router
        // still recognizes the prefix.
        let uri = "attn://review";
        assert_eq!(parse_review_invite(uri), Some(uri.to_string()));
        let uri = "attn://review/";
        assert_eq!(parse_review_invite(uri), Some(uri.to_string()));
    }

    #[test]
    fn parse_review_invite_preserves_fragment_for_crypto_layer() {
        // The fragment must round-trip verbatim — it carries the room key
        // that issue 2.8's crypto layer derives from.
        let uri = "attn://review/room42#key=AAAA-BBBB-CCCC";
        let invite = parse_review_invite(uri).expect("invite recognized");
        assert!(invite.contains("#key=AAAA-BBBB-CCCC"));
    }

    #[test]
    fn parse_review_invite_rejects_lookalike_hosts() {
        // Must not match attn://reviewable/..., attn://review-foo/..., etc.
        assert_eq!(parse_review_invite("attn://reviewable/abc"), None);
        assert_eq!(parse_review_invite("attn://review-foo/abc"), None);
        assert_eq!(parse_review_invite("attn://reviews/abc"), None);
    }

    #[test]
    fn parse_review_invite_rejects_non_review_uris() {
        assert_eq!(parse_review_invite("attn://app/"), None);
        assert_eq!(parse_review_invite("attn://localhost/foo.png"), None);
        assert_eq!(parse_review_invite("https://review/abc"), None);
    }

    #[test]
    fn reserved_localhost_review_detects_collision() {
        assert!(is_reserved_localhost_review("attn://localhost/review"));
        assert!(is_reserved_localhost_review("attn://localhost/review/"));
        assert!(is_reserved_localhost_review(
            "attn://localhost/review/abc#key=xyz"
        ));
    }

    #[test]
    fn reserved_localhost_review_ignores_unrelated_paths() {
        assert!(!is_reserved_localhost_review("attn://localhost/foo.png"));
        assert!(!is_reserved_localhost_review("attn://localhost/reviews"));
        assert!(!is_reserved_localhost_review(
            "attn://localhost/reviewable/abc"
        ));
        assert!(!is_reserved_localhost_review("attn://review/abc"));
    }

    // ----- attn-nnj.2.6 watcher classification ---------------------------
    //
    // These exercise `classify_and_record_changes` end-to-end: build a
    // real AppState (with a ReviewStore + file_to_room mapping), simulate
    // either a WorkingCopyService save (self-write) or a raw fs::write
    // (external), then call the classifier and assert the journal state.

    use crate::review::ids::{FileId, RoomId};
    use crate::review::model::{LocalRevision, RevisionSource};
    use crate::review::store::ReviewStore;
    use crate::review::watcher_state::SelfWriteTracker;
    use crate::review::working_copy::{SaveRequest, SaveSource, WorkingCopyService};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn dummy_id<T: for<'de> serde::Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string())).expect("id deserializes")
    }

    fn make_mapped_state(
        path: PathBuf,
        store: Arc<ReviewStore>,
        tracker: Arc<SelfWriteTracker>,
        room: RoomId,
        file: FileId,
    ) -> Arc<Mutex<ipc::AppState>> {
        let mut map = HashMap::new();
        map.insert(path.clone(), (room, file));
        Arc::new(Mutex::new(ipc::AppState {
            active_path: path.clone(),
            active_project_root: path.parent().map(Path::to_path_buf).unwrap_or_default(),
            active_tab_id: None,
            review_rooms: HashMap::new(),
            file_to_room: map,
            review_store: Some(store),
            self_write_tracker: tracker,
            review_manager: None,
        }))
    }

    #[test]
    fn watcher_classifier_drops_self_writes() {
        // WorkingCopyService::save → SelfWriteTracker has an entry →
        // classify_and_record_changes consumes it and records NOTHING in
        // the revision journal.
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("store"),
        );
        let tracker = Arc::new(SelfWriteTracker::new());
        let path = tmp.path().join("doc.md");
        let room: RoomId = dummy_id("room-self-write");
        let file: FileId = dummy_id("file-self-write");

        let state =
            make_mapped_state(path.clone(), store.clone(), tracker.clone(), room.clone(), file.clone());

        // Save via WCS (records to tracker as a side effect).
        let svc = WorkingCopyService::with_tracker(tracker.clone());
        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "hello world\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save");
        // The IPC save flow would also persist the revision; here we skip
        // it to isolate the classifier — we only care that the classifier
        // doesn't ADD a spurious extra revision.

        classify_and_record_changes(std::slice::from_ref(&path), &state);

        // Tracker entry consumed.
        assert!(
            !tracker.consume_match(&path, &result.next_hash),
            "classifier should have consumed the tracker entry"
        );

        // Journal must be empty — the classifier MUST NOT have written.
        let journal: Vec<LocalRevision> = store
            .iter_revisions(&room, &file)
            .map(|iter| iter.collect::<Result<_, _>>().expect("decode"))
            .unwrap_or_default();
        assert!(
            journal.is_empty(),
            "self-write classification must not emit a journal entry, got {} entries",
            journal.len()
        );
    }

    #[test]
    fn watcher_classifier_records_external_changes() {
        // Bare fs::write (no WCS, no tracker entry) → classifier sees a
        // miss and persists a LocalRevision with source=ExternalFileChange.
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("store"),
        );
        let tracker = Arc::new(SelfWriteTracker::new());
        let path = tmp.path().join("doc.md");
        let room: RoomId = dummy_id("room-external");
        let file: FileId = dummy_id("file-external");

        let state =
            make_mapped_state(path.clone(), store.clone(), tracker, room.clone(), file.clone());

        // Bypass WorkingCopyService entirely.
        std::fs::write(&path, b"external edit\n").expect("seed external write");
        classify_and_record_changes(std::slice::from_ref(&path), &state);

        let journal: Vec<LocalRevision> = store
            .iter_revisions(&room, &file)
            .expect("iter")
            .collect::<Result<_, _>>()
            .expect("decode");
        assert_eq!(
            journal.len(),
            1,
            "external write must record exactly one LocalRevision"
        );
        assert_eq!(journal[0].source, RevisionSource::ExternalFileChange);
        let expected_hash =
            crate::review::crypto::ids::content_hash(b"external edit\n");
        assert_eq!(journal[0].next_hash, expected_hash);
    }

    #[test]
    fn watcher_classifier_external_change_unmapped_path_no_op() {
        // External edit to a path that isn't in any room → no panic, no
        // journal entries written, no reviews/rooms/ dir created.
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let store = Arc::new(
            ReviewStore::open_at(tmp.path().join("reviews")).expect("store"),
        );
        let tracker = Arc::new(SelfWriteTracker::new());
        let path = tmp.path().join("unmapped.md");
        std::fs::write(&path, b"nobody knows\n").expect("seed");

        let state = Arc::new(Mutex::new(ipc::AppState {
            active_path: path.clone(),
            active_project_root: tmp.path().to_path_buf(),
            active_tab_id: None,
            review_rooms: HashMap::new(),
            file_to_room: HashMap::new(),
            review_store: Some(store),
            self_write_tracker: tracker,
            review_manager: None,
        }));

        classify_and_record_changes(std::slice::from_ref(&path), &state);

        let rooms_dir = tmp.path().join("reviews").join("rooms");
        assert!(
            !rooms_dir.exists(),
            "expected no rooms dir created for unmapped path"
        );
    }

    // ----- attn-nnj.3.8 review-dispatch JS routing ----------------------
    //
    // Mirrors the `UserEvent::Review` arm in `run_event_loop`: any new
    // `ReviewUpdate` variant must end up dispatched through the right
    // `window.__attn__.review*` callback. We can't drive a real webview from
    // a unit test, so we instead pin the JS string the handler would call
    // `evaluate_script(...)` with — that string is what wry hands wkwebview.

    use crate::review::manager::ReviewUpdate;
    use crate::review::model::{ExactReason, PositionAnchor, ResolvedAnchor};

    #[test]
    fn review_dispatch_js_routes_anchor_resolution_to_callback() {
        // The 3.8 acceptance criterion: AnchorResolutionChanged must produce
        // a `window.__attn__.reviewAnchorResolution(...)` call carrying the
        // full resolved-anchor payload as camelCase JSON.
        let update = ReviewUpdate::AnchorResolutionChanged {
            room_id: dummy_id::<RoomId>("room-abc"),
            event_id: dummy_id::<crate::review::ids::EventId>("evt-7"),
            file_id: dummy_id::<FileId>("file-3"),
            resolved: ResolvedAnchor::Exact {
                confidence: 1.0,
                current_range: PositionAnchor {
                    byte_range: [0, 11],
                    line_range: [1, 1],
                    pm_range: None,
                },
                reason: ExactReason::BaseHashMatch,
            },
        };

        let js = build_review_dispatch_js(&update).expect("build dispatch js");

        assert!(
            js.starts_with("window.__attn__ && window.__attn__.reviewAnchorResolution("),
            "expected reviewAnchorResolution callback dispatch, got: {js}"
        );
        // The JSON payload must include the camelCase keys the frontend type
        // (ReviewAnchorResolutionUpdate) declares.
        assert!(js.contains("\"roomId\":\"room-abc\""), "missing roomId: {js}");
        assert!(js.contains("\"eventId\":\"evt-7\""), "missing eventId: {js}");
        assert!(js.contains("\"fileId\":\"file-3\""), "missing fileId: {js}");
        assert!(js.contains("\"status\":\"exact\""), "missing resolved.status: {js}");
        assert!(
            js.contains("\"reason\":\"base_hash_match\""),
            "missing resolved.reason: {js}"
        );
    }

    #[test]
    fn review_dispatch_js_picks_correct_callback_per_variant() {
        // Smoke-test the callback selection across the full variant set so a
        // future variant rename doesn't silently mis-route.
        let room: RoomId = dummy_id("room-abc");
        let event: crate::review::ids::EventId = dummy_id("evt-1");

        let cases = vec![
            (
                ReviewUpdate::RoomStatusChanged {
                    room_id: room.clone(),
                    status: "ok".to_string(),
                },
                "reviewStatus",
            ),
            (
                ReviewUpdate::EventImported {
                    room_id: room.clone(),
                    event_id: event.clone(),
                    body_type: "comment_created".to_string(),
                },
                "reviewEvent",
            ),
            (
                ReviewUpdate::SnapshotCreated {
                    room_id: room.clone(),
                    snapshot_id: "snap-1".to_string(),
                    file_id: "file-1".to_string(),
                },
                "reviewSnapshot",
            ),
            (
                ReviewUpdate::AnchorResolutionChanged {
                    room_id: room.clone(),
                    event_id: event.clone(),
                    file_id: dummy_id::<FileId>("file-1"),
                    resolved: ResolvedAnchor::Stale {
                        reason: "low_confidence".to_string(),
                    },
                },
                "reviewAnchorResolution",
            ),
        ];

        for (update, expected_callback) in cases {
            let js = build_review_dispatch_js(&update).expect("build dispatch js");
            let needle = format!("window.__attn__.{expected_callback}(");
            assert!(
                js.contains(&needle),
                "expected callback {expected_callback} in js={js}"
            );
        }
    }
}
