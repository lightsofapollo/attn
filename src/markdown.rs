use serde::Serialize;

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
    pub structure: PlanStructure,
}

pub fn render(markdown: &str) -> RenderResult {
    let structure = extract_structure(markdown);
    RenderResult { structure }
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
        if let Some(text) = trimmed
            .strip_prefix("- [x] ")
            .or_else(|| trimmed.strip_prefix("- [X] "))
        {
            tasks.push(Task {
                line: line_num + 1,
                text: text.to_string(),
                checked: true,
            });
            if let Some(phase) = phases.last_mut() {
                phase.progress.total += 1;
                phase.progress.done += 1;
            }
        } else if let Some(text) = trimmed.strip_prefix("- [ ] ") {
            tasks.push(Task {
                line: line_num + 1,
                text: text.to_string(),
                checked: false,
            });
            if let Some(phase) = phases.last_mut() {
                phase.progress.total += 1;
            }
        }

        // Detect file references (simple heuristic: paths with extensions)
        for word in trimmed.split_whitespace() {
            let cleaned = word
                .trim_matches(|c: char| c == '`' || c == '"' || c == '\'' || c == '(' || c == ')');
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
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".md", ".css", ".html",
        ".json", ".toml", ".yaml", ".yml", ".sql", ".sh", ".bash", ".svelte", ".vue",
    ];
    extensions.iter().any(|ext| s.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::{looks_like_file_path, render};

    #[test]
    fn render_extracts_phases_tasks_and_file_refs() {
        let markdown = r#"
## Phase 1
- [x] shipped parser
- [ ] add docs

See `src/main.rs` and web/src/App.svelte for details.
"#;

        let result = render(markdown);
        assert_eq!(result.structure.phases.len(), 1);
        assert_eq!(result.structure.phases[0].title, "Phase 1");
        assert_eq!(result.structure.phases[0].progress.done, 1);
        assert_eq!(result.structure.phases[0].progress.total, 2);
        assert_eq!(result.structure.tasks.len(), 2);
        assert!(
            result
                .structure
                .file_refs
                .iter()
                .any(|p| p == "src/main.rs")
        );
        assert!(
            result
                .structure
                .file_refs
                .iter()
                .any(|p| p == "web/src/App.svelte")
        );
    }

    #[test]
    fn file_path_heuristic_requires_slash_and_known_extension() {
        assert!(looks_like_file_path("src/lib.rs"));
        assert!(!looks_like_file_path("README.md"));
        assert!(!looks_like_file_path("src/lib.unknown"));
    }
}
