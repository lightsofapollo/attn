use base64::Engine;
use comrak::plugins::syntect::SyntectAdapterBuilder;
use comrak::{markdown_to_html_with_plugins, ExtensionOptions, Options, Plugins, RenderOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Default)]
pub struct PlanStructure {
    pub phases: Vec<Phase>,
    pub tasks: Vec<Task>,
    pub file_refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Phase {
    pub title: String,
    pub progress: Progress,
}

#[derive(Debug, Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct Task {
    pub line: usize,
    pub text: String,
    pub checked: bool,
}

pub struct RenderResult {
    pub html: String,
    pub structure: PlanStructure,
}

pub fn render(markdown: &str) -> RenderResult {
    let adapter = SyntectAdapterBuilder::new()
        .css()
        .build();

    let mut options = Options::default();
    options.extension = ExtensionOptions {
        strikethrough: true,
        table: true,
        autolink: true,
        tasklist: true,
        footnotes: true,
        ..Default::default()
    };
    options.render = RenderOptions {
        unsafe_: true, // allow raw HTML in markdown
        ..Default::default()
    };

    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&adapter);

    let raw_html = markdown_to_html_with_plugins(markdown, &options, &plugins);
    let html = rewrite_mermaid_blocks(&raw_html);

    // Extract plan structure from source
    let structure = extract_structure(markdown);

    RenderResult { html, structure }
}

fn extract_structure(markdown: &str) -> PlanStructure {
    let mut phases: Vec<Phase> = Vec::new();
    let mut tasks: Vec<Task> = Vec::new();
    let mut file_refs: Vec<String> = Vec::new();

    for (line_num, line) in markdown.lines().enumerate() {
        let trimmed = line.trim();

        // Detect top-level headers as phases
        if trimmed.starts_with("## ") {
            phases.push(Phase {
                title: trimmed.trim_start_matches('#').trim().to_string(),
                progress: Progress { done: 0, total: 0 },
            });
        }

        // Detect task list items
        if trimmed.starts_with("- [x] ") || trimmed.starts_with("- [X] ") {
            let text = trimmed[6..].to_string();
            tasks.push(Task {
                line: line_num + 1,
                text,
                checked: true,
            });
            if let Some(phase) = phases.last_mut() {
                phase.progress.total += 1;
                phase.progress.done += 1;
            }
        } else if trimmed.starts_with("- [ ] ") {
            let text = trimmed[6..].to_string();
            tasks.push(Task {
                line: line_num + 1,
                text,
                checked: false,
            });
            if let Some(phase) = phases.last_mut() {
                phase.progress.total += 1;
            }
        }

        // Detect file references (simple heuristic: paths with extensions)
        for word in trimmed.split_whitespace() {
            let cleaned = word.trim_matches(|c: char| c == '`' || c == '"' || c == '\'' || c == '(' || c == ')');
            if looks_like_file_path(cleaned) {
                file_refs.push(cleaned.to_string());
            }
        }
    }

    PlanStructure {
        phases,
        tasks,
        file_refs,
    }
}

fn looks_like_file_path(s: &str) -> bool {
    if s.len() < 4 {
        return false;
    }
    // Must contain a slash and a dot-extension
    if !s.contains('/') {
        return false;
    }
    let extensions = [
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java",
        ".md", ".css", ".html", ".json", ".toml", ".yaml", ".yml",
        ".sql", ".sh", ".bash", ".svelte", ".vue",
    ];
    extensions.iter().any(|ext| s.ends_with(ext))
}

/// Replace `<pre><code class="language-mermaid">…</code></pre>` blocks with
/// `<div class="mermaid-block" data-content="BASE64">` so the frontend can
/// render them with the Mermaid library.
fn rewrite_mermaid_blocks(html: &str) -> String {
    const OPEN_TAG: &str = "<pre><code class=\"language-mermaid\">";
    const CLOSE_TAG: &str = "</code></pre>";

    let mut result = String::with_capacity(html.len());
    let mut remaining = html;

    while let Some(start) = remaining.find(OPEN_TAG) {
        // Push everything before this block verbatim
        result.push_str(&remaining[..start]);

        let after_open = &remaining[start + OPEN_TAG.len()..];
        if let Some(end) = after_open.find(CLOSE_TAG) {
            let code_content = &after_open[..end];
            // Decode HTML entities back to raw text before base64-encoding
            let decoded = html_entity_decode(code_content);
            let b64 = base64::engine::general_purpose::STANDARD.encode(decoded.as_bytes());
            result.push_str(&format!(
                "<div class=\"mermaid-block\" data-content=\"{}\"></div>",
                b64
            ));
            remaining = &after_open[end + CLOSE_TAG.len()..];
        } else {
            // Malformed — no closing tag; emit as-is and stop rewriting
            result.push_str(&remaining[start..]);
            remaining = "";
            break;
        }
    }

    result.push_str(remaining);
    result
}

/// Minimal HTML entity decoding for the entities comrak might produce inside
/// code blocks.
fn html_entity_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

pub fn render_directory_listing(dir: &Path) -> String {
    let mut entries: Vec<String> = Vec::new();

    if let Ok(read_dir) = std::fs::read_dir(dir) {
        let mut items: Vec<_> = read_dir
            .filter_map(|e| e.ok())
            .collect();
        items.sort_by_key(|e| e.file_name());

        for entry in items {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if name.starts_with('.') {
                continue;
            }
            if is_dir {
                entries.push(format!("<div class=\"dir-entry dir\">{}/</div>", name));
            } else if name.ends_with(".md") {
                entries.push(format!("<div class=\"dir-entry file\">{}</div>", name));
            }
        }
    }

    format!(
        "<div class=\"directory-listing\"><h1>{}</h1>{}</div>",
        dir.file_name().unwrap_or_default().to_string_lossy(),
        entries.join("\n")
    )
}
