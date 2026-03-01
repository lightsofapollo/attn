use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_KNOWN_PROJECTS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectRegistry {
    #[serde(default)]
    pub known_projects: Vec<String>,
    #[serde(default)]
    pub active_project: Option<String>,
}

pub fn normalize_project_root(path: &Path) -> PathBuf {
    let root = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

pub fn load_registry() -> ProjectRegistry {
    let path = registry_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ProjectRegistry::default();
    };
    match serde_json::from_str::<ProjectRegistry>(&raw) {
        Ok(mut registry) => {
            registry
                .known_projects
                .retain(|entry| !entry.trim().is_empty());
            registry
        }
        Err(e) => {
            eprintln!(
                "attn: could not parse project registry {}: {}",
                path.display(),
                e
            );
            ProjectRegistry::default()
        }
    }
}

pub fn set_active_project(path: &Path) -> Result<ProjectRegistry> {
    let mut registry = load_registry();
    let normalized = normalize_project_root(path).to_string_lossy().to_string();

    registry.known_projects.retain(|entry| entry != &normalized);
    registry.known_projects.insert(0, normalized.clone());
    registry.known_projects.truncate(MAX_KNOWN_PROJECTS);
    registry.active_project = Some(normalized);

    save_registry(&registry)?;
    Ok(registry)
}

fn save_registry(registry: &ProjectRegistry) -> Result<()> {
    let dir = storage_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    let path = registry_path();
    let payload = serde_json::to_string_pretty(registry).context("could not serialize registry")?;
    std::fs::write(&path, payload).with_context(|| format!("could not write {}", path.display()))
}

fn registry_path() -> PathBuf {
    storage_dir().join("projects.json")
}

fn storage_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_STATE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("attn");
        }
    }

    if let Some(path) = dirs::data_local_dir() {
        return path.join("attn");
    }

    if let Some(home) = dirs::home_dir() {
        return home.join(".attn");
    }

    PathBuf::from(".attn")
}

#[cfg(test)]
mod tests {
    use super::normalize_project_root;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("attn-project-tests-{nanos}"))
    }

    #[test]
    fn normalize_project_root_uses_parent_for_files() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        let file_path = root.join("plan.md");
        std::fs::write(&file_path, "# plan").expect("write temp file");

        let normalized = normalize_project_root(&file_path);
        assert_eq!(normalized, root.canonicalize().expect("canonicalize root"));

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn normalize_project_root_handles_directories() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");

        let normalized = normalize_project_root(&root);
        assert_eq!(normalized, root.canonicalize().expect("canonicalize root"));

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }
}
