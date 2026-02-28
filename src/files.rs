use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(rename = "fileType")]
    pub file_type: FileType,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Markdown,
    Image,
    Video,
    Audio,
    Directory,
    Unsupported,
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "out" | "coverage" | "__pycache__" | "venv"
    )
}

const MAX_TREE_NODES: usize = 5_000;

pub fn detect_file_type(path: &Path) -> FileType {
    if path.is_dir() {
        return FileType::Directory;
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("md" | "markdown") => FileType::Markdown,
        Some("png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "ico") => FileType::Image,
        Some("mp4" | "webm" | "mov" | "avi") => FileType::Video,
        Some("mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac") => FileType::Audio,
        _ => FileType::Unsupported,
    }
}

/// Read a directory tree recursively. Skip hidden files/dirs (starting with .).
/// Skip bulky build/dependency dirs and symlinks.
/// Include only directories and previewable file types.
/// Sort: directories first, then alphabetical.
pub fn read_tree(root: &Path) -> Vec<TreeNode> {
    let mut remaining = MAX_TREE_NODES;
    read_tree_limited(root, &mut remaining)
}

fn read_tree_limited(root: &Path, remaining: &mut usize) -> Vec<TreeNode> {
    let mut entries = Vec::new();
    if *remaining == 0 {
        return entries;
    }

    let Ok(read_dir) = std::fs::read_dir(root) else {
        return entries;
    };

    for entry in read_dir.flatten() {
        if *remaining == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs
        if name.starts_with('.') {
            continue;
        }
        if should_skip_dir(&name) {
            continue;
        }

        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let is_dir = path.is_dir();
        let file_type = detect_file_type(&path);
        let children = if is_dir {
            Some(read_tree_limited(&path, remaining))
        } else {
            None
        };

        // Keep only directories with visible children and previewable file types.
        if is_dir {
            if children.as_ref().is_none_or(Vec::is_empty) {
                continue;
            }
        } else if matches!(file_type, FileType::Unsupported) {
            continue;
        }

        entries.push(TreeNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
            file_type,
        });
        *remaining = remaining.saturating_sub(1);
    }

    // Sort: directories first, then alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    entries
}
