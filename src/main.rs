mod ipc;
mod markdown;
mod watcher;

use clap::Parser;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
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
}

fn main() {
    let cli = Cli::parse();
    let path = cli.path.canonicalize().unwrap_or_else(|_| {
        eprintln!("attn: cannot open '{}'", cli.path.display());
        std::process::exit(1);
    });

    // Headless modes — stdout only, no window
    if cli.status || cli.json || cli.check {
        let content = if path.is_file() {
            std::fs::read_to_string(&path).unwrap_or_else(|e| {
                eprintln!("attn: {}", e);
                std::process::exit(1);
            })
        } else {
            eprintln!("attn: headless modes require a file path");
            std::process::exit(1);
        };

        let result = markdown::render(&content);

        if cli.json {
            println!("{}", serde_json::to_string_pretty(&result.structure).unwrap());
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
        return;
    }

    // Read initial content
    let (initial_html, initial_raw, initial_structure) = if path.is_file() {
        let content = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            eprintln!("attn: {}", e);
            std::process::exit(1);
        });
        let result = markdown::render(&content);
        (result.html, content, result.structure)
    } else {
        // Directory mode — render a file listing for now
        let listing = markdown::render_directory_listing(&path);
        let structure = markdown::PlanStructure::default();
        (listing.clone(), String::new(), structure)
    };

    // Determine theme
    let theme = if cli.dark {
        "dark"
    } else if cli.light {
        "light"
    } else {
        "system"
    };

    // Build the initial page HTML with embedded assets
    let page_html = build_page_html(&initial_html, &initial_raw, &initial_structure, theme);

    // Create window and webview with typed event loop
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    // Start file watcher if we are viewing a single file
    let _file_watcher = if path.is_file() {
        let proxy = event_loop.create_proxy();
        match watcher::FileWatcher::new(&path, proxy) {
            Ok(fw) => Some(fw),
            Err(e) => {
                eprintln!("attn: could not watch file: {}", e);
                None
            }
        }
    } else {
        None
    };

    let window = WindowBuilder::new()
        .with_title("attn")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 720.0))
        .build(&event_loop)
        .expect("failed to create window");

    // Shared state for the IPC handler
    let app_state = Arc::new(Mutex::new(ipc::AppState {
        file_path: path.clone(),
    }));
    let ipc_state = Arc::clone(&app_state);

    let webview = WebViewBuilder::new()
        .with_html(&page_html)
        .with_ipc_handler(move |msg| {
            ipc::handle_message(msg.body(), &ipc_state);
        })
        .with_navigation_handler(|url| {
            // Allow initial page load and data URIs, open everything else in default browser
            if url.starts_with("data:") || url.starts_with("about:") {
                true // allow navigation within webview
            } else {
                let _ = open::that(&url);
                false // block navigation in webview
            }
        })
        .build(&window)
        .expect("failed to create webview");

    // Keep a clone of the path for the event loop closure
    let watched_path = path.clone();

    // Run event loop
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::FileChanged) => {
                if watched_path.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&watched_path) {
                        let result = markdown::render(&content);
                        let structure_json =
                            serde_json::to_string(&result.structure).unwrap_or_default();
                        let escaped_html = result
                            .html
                            .replace('\\', "\\\\")
                            .replace('\'', "\\'")
                            .replace('\n', "\\n")
                            .replace('\r', "");
                        let escaped_raw = content
                            .replace('\\', "\\\\")
                            .replace('\'', "\\'")
                            .replace('\n', "\\n")
                            .replace('\r', "");

                        let js = format!(
                            "window.__attn__.updateContent({{ html: '{}', rawMarkdown: '{}', structure: {} }});",
                            escaped_html, escaped_raw, structure_json
                        );

                        let _ = webview.evaluate_script(&js);
                    }
                }
            }
            _ => {}
        }
    });
}

fn build_page_html(
    rendered_html: &str,
    raw_markdown: &str,
    structure: &markdown::PlanStructure,
    theme: &str,
) -> String {
    let structure_json = serde_json::to_string(structure).unwrap_or_default();
    let escaped_raw = raw_markdown.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");

    format!(
        r#"<!DOCTYPE html>
<html data-theme="{theme}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>attn</title>
    <style>{css}</style>
</head>
<body>
    <article id="content">{rendered_html}</article>
    <script>
        window.__attn__ = {{
            rawMarkdown: `{escaped_raw}`,
            structure: {structure_json},
            mode: 'read',
        }};

        window.__attn__.setContent = function(data) {{
            document.getElementById('content').innerHTML = data.html;
            window.__attn__.rawMarkdown = data.rawMarkdown;
            window.__attn__.structure = data.structure;
        }};

        window.__attn__.updateContent = function(data) {{
            document.getElementById('content').innerHTML = data.html;
            if (data.rawMarkdown) window.__attn__.rawMarkdown = data.rawMarkdown;
            if (data.structure) window.__attn__.structure = data.structure;
        }};

        // Checkbox toggling in read mode
        document.addEventListener('click', function(e) {{
            const checkbox = e.target.closest('input[type="checkbox"]');
            if (checkbox) {{
                e.preventDefault();
                // Find which task checkbox this is (index among all task checkboxes)
                const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
                const taskIndex = Array.from(allCheckboxes).indexOf(checkbox);
                const tasks = window.__attn__.structure && window.__attn__.structure.tasks;
                if (tasks && taskIndex >= 0 && taskIndex < tasks.length) {{
                    window.ipc.postMessage(JSON.stringify({{
                        type: 'checkbox_toggle',
                        line: tasks[taskIndex].line,
                        checked: !checkbox.checked,
                    }}));
                }}
            }}
        }});

        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {{
            if (window.__attn__.mode === 'edit') return;

            switch(e.key) {{
                case 'q':
                    window.ipc.postMessage(JSON.stringify({{ type: 'quit' }}));
                    break;
                case 'j':
                    window.scrollBy(0, 60);
                    break;
                case 'k':
                    window.scrollBy(0, -60);
                    break;
                case ' ':
                    e.preventDefault();
                    window.scrollBy(0, window.innerHeight * 0.8);
                    break;
                case 'g':
                    window.scrollTo(0, 0);
                    break;
                case 'G':
                    window.scrollTo(0, document.body.scrollHeight);
                    break;
                case 't':
                    const html = document.documentElement;
                    const current = html.dataset.theme;
                    html.dataset.theme = current === 'dark' ? 'light' : 'dark';
                    break;
            }}
        }});
    </script>
</body>
</html>"#,
        theme = theme,
        css = include_str!("../web/styles/base.css"),
        rendered_html = rendered_html,
        escaped_raw = escaped_raw,
        structure_json = structure_json,
    )
}
