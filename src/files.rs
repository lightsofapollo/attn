use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: String,
    #[serde(rename = "fileType")]
    pub file_type: FileType,
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "out" | "coverage" | "__pycache__" | "venv"
    )
}

const MAX_TREE_NODES: usize = 5_000;
const MAX_ROOT_SNAPSHOT_NODES: usize = 256;

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

/// Read only one level of the tree for fast first paint.
/// Directories are included with empty children placeholders.
pub fn read_tree_root_snapshot(root: &Path) -> Vec<TreeNode> {
    let mut remaining = MAX_ROOT_SNAPSHOT_NODES;
    let mut scan_budget = MAX_TREE_NODES;
    read_tree_shallow(root, &mut remaining, &mut scan_budget)
}

/// Find the first previewable file quickly without building a full sidebar tree.
pub fn find_first_previewable_path(root: &Path) -> Option<PathBuf> {
    let mut remaining = MAX_TREE_NODES;
    find_first_previewable_path_limited(root, &mut remaining)
}

pub fn search_previewable_files(root: &Path, query: &str, max_results: usize) -> Vec<SearchResult> {
    let normalized = query.trim();
    if normalized.is_empty() || max_results == 0 {
        return Vec::new();
    }

    let pattern = Pattern::parse(normalized, CaseMatching::Ignore, Normalization::Smart);
    if pattern.atoms.is_empty() {
        return Vec::new();
    }

    let mut remaining = MAX_TREE_NODES;
    let mut candidates = Vec::new();
    collect_previewable_candidates_limited(root, root, &mut remaining, &mut candidates);

    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buf = Vec::new();
    let mut ranked = Vec::new();

    for candidate in candidates {
        let Some(score) = pattern.score(
            Utf32Str::new(candidate.match_path.as_str(), &mut utf32_buf),
            &mut matcher,
        ) else {
            continue;
        };
        ranked.push((score, candidate));
    }

    ranked.sort_by(|(score_a, candidate_a), (score_b, candidate_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| {
                candidate_a
                    .match_path
                    .len()
                    .cmp(&candidate_b.match_path.len())
            })
            .then_with(|| candidate_a.path.cmp(&candidate_b.path))
    });

    ranked
        .into_iter()
        .take(max_results)
        .map(|(_, candidate)| SearchResult {
            path: candidate.path,
            file_type: candidate.file_type,
        })
        .collect()
}

fn is_previewable(file_type: &FileType) -> bool {
    matches!(
        file_type,
        FileType::Markdown | FileType::Image | FileType::Video | FileType::Audio
    )
}

pub fn directory_has_previewable_descendant(path: &Path) -> bool {
    let mut remaining = MAX_TREE_NODES;
    directory_has_previewable_descendant_limited(path, &mut remaining)
}

fn sorted_entries(root: &Path) -> Vec<(String, std::fs::DirEntry)> {
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut entries: Vec<(String, std::fs::DirEntry)> = read_dir
        .flatten()
        .map(|entry| (entry.file_name().to_string_lossy().to_string(), entry))
        .filter(|(name, _)| !name.starts_with('.') && !should_skip_dir(name))
        .collect();

    entries.sort_by(|(a_name, a_entry), (b_name, b_entry)| {
        let a_is_dir = a_entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b_entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a_name.to_lowercase().cmp(&b_name.to_lowercase()))
    });

    entries
}

fn read_tree_shallow(root: &Path, remaining: &mut usize, scan_budget: &mut usize) -> Vec<TreeNode> {
    let mut entries = Vec::new();
    if *remaining == 0 {
        return entries;
    }

    for (name, entry) in sorted_entries(root) {
        if *remaining == 0 {
            break;
        }
        *remaining = remaining.saturating_sub(1);

        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }

        let is_dir = ft.is_dir();
        let file_type = detect_file_type(&path);

        if is_dir && !directory_has_previewable_descendant_limited(&path, scan_budget) {
            continue;
        }

        if !is_dir && !is_previewable(&file_type) {
            continue;
        }

        entries.push(TreeNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: if is_dir { Some(Vec::new()) } else { None },
            file_type,
        });
    }

    entries
}

fn directory_has_previewable_descendant_limited(root: &Path, remaining: &mut usize) -> bool {
    if *remaining == 0 {
        return false;
    }

    for (_name, entry) in sorted_entries(root) {
        if *remaining == 0 {
            break;
        }
        *remaining = remaining.saturating_sub(1);

        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_file() {
            if is_previewable(&detect_file_type(&path)) {
                return true;
            }
            continue;
        }
        if ft.is_dir() && directory_has_previewable_descendant_limited(&path, remaining) {
            return true;
        }
    }

    false
}

fn find_first_previewable_path_limited(root: &Path, remaining: &mut usize) -> Option<PathBuf> {
    if *remaining == 0 {
        return None;
    }

    for (_name, entry) in sorted_entries(root) {
        if *remaining == 0 {
            break;
        }
        *remaining = remaining.saturating_sub(1);

        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_file() {
            let file_type = detect_file_type(&path);
            if is_previewable(&file_type) {
                return Some(path);
            }
            continue;
        }
        if ft.is_dir()
            && let Some(found) = find_first_previewable_path_limited(&path, remaining)
        {
            return Some(found);
        }
    }

    None
}

struct SearchCandidate {
    path: String,
    match_path: String,
    file_type: FileType,
}

fn collect_previewable_candidates_limited(
    project_root: &Path,
    current_dir: &Path,
    remaining: &mut usize,
    candidates: &mut Vec<SearchCandidate>,
) {
    if *remaining == 0 {
        return;
    }

    for (name, entry) in sorted_entries(current_dir) {
        if *remaining == 0 {
            break;
        }
        *remaining = remaining.saturating_sub(1);

        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }

        if ft.is_dir() {
            collect_previewable_candidates_limited(project_root, &path, remaining, candidates);
            continue;
        }

        let file_type = detect_file_type(&path);
        if !is_previewable(&file_type) {
            continue;
        }

        candidates.push(SearchCandidate {
            path: path.to_string_lossy().to_string(),
            match_path: path_for_match(project_root, &path, &name),
            file_type,
        });
    }
}

fn path_for_match(root: &Path, path: &Path, name: &str) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .filter(|rel| !rel.is_empty())
        .unwrap_or_else(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        FileType, detect_file_type, find_first_previewable_path, read_tree_root_snapshot,
        search_previewable_files,
    };
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("attn-tests-{nanos}"))
    }

    #[test]
    fn detect_file_type_handles_supported_extensions() {
        assert!(matches!(
            detect_file_type(Path::new("doc.md")),
            FileType::Markdown
        ));
        assert!(matches!(
            detect_file_type(Path::new("image.png")),
            FileType::Image
        ));
        assert!(matches!(
            detect_file_type(Path::new("video.mp4")),
            FileType::Video
        ));
        assert!(matches!(
            detect_file_type(Path::new("audio.mp3")),
            FileType::Audio
        ));
        assert!(matches!(
            detect_file_type(Path::new("archive.zip")),
            FileType::Unsupported
        ));
    }

    #[test]
    fn first_previewable_path_prefers_previewable_files() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        let nested = root.join("docs");
        std::fs::create_dir_all(&nested).expect("create nested dir");
        std::fs::write(root.join("notes.txt"), "not previewable").expect("write text file");
        std::fs::write(nested.join("readme.md"), "# hello").expect("write markdown file");

        let found = find_first_previewable_path(&root).expect("should find previewable file");
        assert_eq!(
            found.file_name().and_then(|n| n.to_str()),
            Some("readme.md")
        );

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn tree_snapshot_hides_empty_directories() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        std::fs::create_dir_all(root.join("empty/sub")).expect("create empty nested dir");
        std::fs::write(root.join("notes.txt"), "not previewable").expect("write text file");

        let snapshot = read_tree_root_snapshot(&root);
        assert!(snapshot.is_empty());

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn tree_snapshot_keeps_directories_with_previewable_descendants() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        let docs = root.join("docs");
        std::fs::create_dir_all(&docs).expect("create docs dir");
        std::fs::write(docs.join("readme.md"), "# hi").expect("write markdown");

        let snapshot = read_tree_root_snapshot(&root);
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].is_dir);
        assert_eq!(snapshot[0].name, "docs");

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn search_previewable_files_supports_non_contiguous_fuzzy_matches() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        let docs = root.join("docs");
        std::fs::create_dir_all(&docs).expect("create docs dir");
        std::fs::write(root.join("core-module.md"), "# top").expect("write top file");
        std::fs::write(docs.join("module-guide.md"), "# guide").expect("write nested file");

        let results = search_previewable_files(&root, "crmdl", 10);
        assert_eq!(results.len(), 1);
        assert!(
            results[0].path.ends_with("core-module.md"),
            "expected fuzzy query to match non-contiguous filename characters, got {:?}",
            results
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>()
        );

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn search_previewable_files_supports_multi_term_path_queries() {
        let root = unique_temp_dir();
        std::fs::create_dir_all(&root).expect("create temp root");
        let docs = root.join("docs").join("api");
        std::fs::create_dir_all(&docs).expect("create nested docs dir");
        std::fs::write(docs.join("reference.md"), "# ref").expect("write nested file");
        std::fs::write(root.join("readme.md"), "# readme").expect("write root file");

        let results = search_previewable_files(&root, "docs ref", 10);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("docs/api/reference.md"));

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }
}
