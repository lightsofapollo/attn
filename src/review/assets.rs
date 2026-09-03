//! Which images a shared document references, and which of them may be sent.
//!
//! A markdown image src is written relative to the FILE. A reviewer has the
//! document's text and nothing else, so every relative src fails on their
//! machine and renders the placeholder card from `image-nodeview.ts`. To show
//! them the picture the owner has to publish the bytes as `DocType::Asset`
//! snapshots (attn-udu8).
//!
//! That makes this module a gate on outbound file reads, and it is written as
//! one. The document being scanned is frequently agent-authored — nobody read
//! every line of it — and a single `![](../../../.ssh/id_rsa)` would otherwise
//! turn "share my notes" into an exfiltration primitive. Every src is refused
//! unless it is provably a plain, allowlisted image file inside the directory
//! the user chose to share.
//!
//! The rules are deliberately STRICTER than `resolveImageSrc` in
//! markdown-layer.ts, which resolves srcs for DISPLAY on the machine that
//! already has the files. Displaying a file the user can open anyway costs
//! nothing; transmitting it is irreversible. Two rules in particular diverge:
//! a filesystem-absolute src is displayed but never sent, and a src that
//! escapes the share root is displayed but never sent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Extensions whose bytes may be published. An allowlist rather than a
/// denylist: an unknown extension is a file we have no reason to send.
/// `svg` is included and is the one entry that carries script — it is safe
/// HERE because a referenced svg is loaded as an image document (scripts
/// inert), the same reasoning `image-nodeview.ts` records for the display
/// side. It must never be reused for a src that could become a frame.
const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("svg", "image/svg+xml"),
];

/// Largest single asset that may be published. Generous for a screenshot or a
/// diagram, small enough that one pathological file cannot dominate a share.
pub const MAX_ASSET_BYTES: u64 = 3 * 1024 * 1024;

/// Ceiling on everything one document contributes. A snapshot is base64url'd
/// into an encrypted envelope, so the wire cost is ~4/3 of this.
pub const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

/// Ceiling on how many assets one document contributes, so a generated file
/// with a thousand thumbnails cannot stall a share.
pub const MAX_ASSET_COUNT: usize = 64;

/// An image the owner will publish alongside the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferencedImage {
    /// The src exactly as authored, e.g. `./chart.svg`. This is the key the
    /// reviewer looks up: it is what their copy of the document contains.
    pub authored_src: String,
    /// Absolute path to the file on the owner's disk.
    pub path: PathBuf,
    pub media_type: String,
    pub bytes: u64,
}

/// Why a referenced src will not be sent. Carried so the Share dialog can say
/// what it is leaving out — an image silently missing from a review is the
/// thing this whole feature exists to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// `https:`, `data:`, protocol-relative — already loadable, or not a file.
    NotLocal,
    /// Resolved outside the shared directory. Includes every filesystem-
    /// absolute src: `/Users/me/secret.png` is outside any share root that
    /// does not contain it, and treating it otherwise would make the
    /// confinement depend on how the src happened to be spelled.
    EscapesShareRoot,
    /// A symlink, or reached through one. Refused rather than resolved: the
    /// link's target is chosen by whoever wrote the file, not by the user.
    Symlink,
    /// Not a regular file — a directory, device, socket, fifo.
    NotARegularFile,
    NotAnImage,
    Missing,
    TooLarge,
    /// The per-document count or byte budget was already spent.
    BudgetExhausted,
}

impl SkipReason {
    /// One short phrase, for the Share dialog and the daemon log.
    pub fn describe(self) -> &'static str {
        match self {
            SkipReason::NotLocal => "not a local file",
            SkipReason::EscapesShareRoot => "outside the shared folder",
            SkipReason::Symlink => "symbolic link",
            SkipReason::NotARegularFile => "not a regular file",
            SkipReason::NotAnImage => "not a supported image type",
            SkipReason::Missing => "file not found",
            SkipReason::TooLarge => "larger than the 8 MB limit",
            SkipReason::BudgetExhausted => "share image budget reached",
        }
    }
}

/// A src that will not be sent, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedImage {
    pub authored_src: String,
    pub reason: SkipReason,
}

/// What one document contributes to a share.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageScan {
    pub included: Vec<ReferencedImage>,
    pub skipped: Vec<SkippedImage>,
}

impl ImageScan {
    pub fn total_bytes(&self) -> u64 {
        self.included.iter().map(|image| image.bytes).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.included.is_empty()
    }
}

/// Collect the image srcs a markdown document references, in source order,
/// deduplicated by authored spelling.
///
/// Uses comrak rather than a regex so the set matches what actually renders:
/// a src inside a fenced code block or an inline-code span is not an image and
/// must not cause a file read.
fn image_srcs(markdown: &str) -> Vec<String> {
    use comrak::nodes::NodeValue;
    use comrak::{Arena, Options, parse_document};

    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    let root = parse_document(&arena, markdown, &options);

    let mut seen: HashSet<String> = HashSet::new();
    let mut srcs = Vec::new();
    for node in root.descendants() {
        if let NodeValue::Image(link) = &node.data.borrow().value {
            let src = link.url.clone();
            if !src.is_empty() && seen.insert(src.clone()) {
                srcs.push(src);
            }
        }
    }
    srcs
}

/// True when the src addresses something other than a path on this disk.
fn is_non_local(src: &str) -> bool {
    if src.starts_with("//") || src.starts_with('#') {
        return true;
    }
    // `scheme:` — the prefix before the first colon must be a well-formed
    // scheme of 2+ characters, so a bare Windows drive letter (`C:/…`) is not
    // read as one. Windows is not a supported host; such a src falls through
    // to the confinement check like any other path.
    let Some(colon) = src.find(':') else {
        return false;
    };
    let scheme = &src[..colon];
    scheme.len() >= 2
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}

/// Percent-decode one path segment, falling back to the raw bytes on a
/// malformed escape. Mirrors `decodeSegment` in markdown-layer.ts: the src has
/// already been through a markdown parser's URL normalisation, so `café.png`
/// arrives as `caf%C3%A9.png` and must be decoded to name the real file.
fn decode_segment(segment: &str) -> String {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| segment.to_string())
}

/// Resolve an authored src to a lexical path, without touching the disk.
///
/// Returns `None` for a src that cannot name a file at all. Splitting on `/`
/// AFTER decoding matters for the same reason it does in markdown-layer.ts: an
/// encoded `%2F` becomes a real separator, so it has to be treated as one here
/// or the traversal check below would reason about a different path than the
/// one that gets opened.
fn resolve_lexically(doc_dir: &Path, src: &str) -> Option<PathBuf> {
    let segments: Vec<String> = src
        .split('/')
        .flat_map(|piece| {
            decode_segment(piece)
                .split('/')
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    let last = segments.last()?;
    if last.is_empty() || last == "." || last == ".." {
        return None;
    }

    let mut path = if src.starts_with('/') {
        PathBuf::from("/")
    } else {
        doc_dir.to_path_buf()
    };
    for segment in &segments {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            // Pop lexically. The result is checked against the share root
            // afterwards, so a src that climbs out is caught there.
            path.pop();
            continue;
        }
        path.push(segment);
    }
    Some(path)
}

fn media_type_for(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, media)| *media)
}

/// Decide which images referenced by `doc_path` may be published.
///
/// `share_root` is the directory the user chose to share — a single shared
/// file's own parent, or the shared folder. Nothing outside it is ever sent,
/// whatever the document asks for.
pub fn scan_document_images(markdown: &str, doc_path: &Path, share_root: &Path) -> ImageScan {
    let mut scan = ImageScan::default();
    let Some(doc_dir) = doc_path.parent() else {
        return scan;
    };
    // Canonicalise the root once so the comparison below is between two real
    // paths — a share root reached through a symlinked parent would otherwise
    // never prefix-match its own contents.
    let Ok(root) = std::fs::canonicalize(share_root) else {
        return scan;
    };

    let mut spent_bytes: u64 = 0;
    for src in image_srcs(markdown) {
        let skip = |reason: SkipReason, scan: &mut ImageScan| {
            scan.skipped.push(SkippedImage {
                authored_src: src.clone(),
                reason,
            });
        };

        if is_non_local(&src) {
            skip(SkipReason::NotLocal, &mut scan);
            continue;
        }
        let Some(lexical) = resolve_lexically(doc_dir, &src) else {
            skip(SkipReason::Missing, &mut scan);
            continue;
        };
        if media_type_for(&lexical).is_none() {
            skip(SkipReason::NotAnImage, &mut scan);
            continue;
        }
        // Refuse symlinks BEFORE canonicalising: canonicalize() would follow
        // the link and report the target as an ordinary file inside the root,
        // which is exactly the check being evaded.
        match std::fs::symlink_metadata(&lexical) {
            Ok(meta) if meta.file_type().is_symlink() => {
                skip(SkipReason::Symlink, &mut scan);
                continue;
            }
            Ok(meta) if !meta.is_file() => {
                skip(SkipReason::NotARegularFile, &mut scan);
                continue;
            }
            Ok(_) => {}
            Err(_) => {
                skip(SkipReason::Missing, &mut scan);
                continue;
            }
        }
        let Ok(canonical) = std::fs::canonicalize(&lexical) else {
            skip(SkipReason::Missing, &mut scan);
            continue;
        };
        if !canonical.starts_with(&root) {
            skip(SkipReason::EscapesShareRoot, &mut scan);
            continue;
        }
        let Ok(meta) = std::fs::metadata(&canonical) else {
            skip(SkipReason::Missing, &mut scan);
            continue;
        };
        if meta.len() > MAX_ASSET_BYTES {
            skip(SkipReason::TooLarge, &mut scan);
            continue;
        }
        if scan.included.len() >= MAX_ASSET_COUNT
            || spent_bytes.saturating_add(meta.len()) > MAX_TOTAL_BYTES
        {
            skip(SkipReason::BudgetExhausted, &mut scan);
            continue;
        }
        let media_type = media_type_for(&canonical).unwrap_or("application/octet-stream");
        spent_bytes = spent_bytes.saturating_add(meta.len());
        scan.included.push(ReferencedImage {
            authored_src: src.clone(),
            path: canonical,
            media_type: media_type.to_string(),
            bytes: meta.len(),
        });
    }
    scan
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(dir: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(&path, bytes).expect("write");
        path
    }

    #[test]
    fn collects_relative_srcs_in_source_order_without_duplicates() {
        let srcs = image_srcs("![a](./one.png)\n\n![b](two.png)\n\n![c](./one.png)\n");
        assert_eq!(srcs, vec!["./one.png", "two.png"]);
    }

    #[test]
    fn a_src_inside_code_is_not_an_image() {
        // The whole reason for parsing rather than regexing: this must not
        // cause a file read, let alone a publish.
        let srcs = image_srcs("```\n![a](./secret.png)\n```\n\nand `![b](./also.png)`\n");
        assert!(srcs.is_empty(), "got {srcs:?}");
    }

    #[test]
    fn remote_and_data_srcs_are_skipped_as_not_local() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        let markdown = "![a](https://example.com/x.png)\n\n![b](data:image/png;base64,AA)\n\n![c](//cdn/x.png)\n";
        let scan = scan_document_images(markdown, &doc, tmp.path());
        assert!(scan.included.is_empty());
        assert_eq!(scan.skipped.len(), 3);
        assert!(
            scan.skipped
                .iter()
                .all(|s| s.reason == SkipReason::NotLocal)
        );
    }

    #[test]
    fn a_sibling_image_is_included_with_its_media_type() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        write(tmp.path(), "chart.svg", b"<svg/>");
        let scan = scan_document_images("![a](./chart.svg)", &doc, tmp.path());
        assert_eq!(scan.included.len(), 1, "skipped: {:?}", scan.skipped);
        assert_eq!(scan.included[0].authored_src, "./chart.svg");
        assert_eq!(scan.included[0].media_type, "image/svg+xml");
        assert_eq!(scan.included[0].bytes, 6);
    }

    #[test]
    fn a_subdirectory_image_is_included() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        write(tmp.path(), "nested/diagram.png", b"\x89PNG");
        let scan = scan_document_images("![a](./nested/diagram.png)", &doc, tmp.path());
        assert_eq!(scan.included.len(), 1, "skipped: {:?}", scan.skipped);
        assert_eq!(scan.included[0].media_type, "image/png");
    }

    #[test]
    fn traversal_out_of_the_share_root_is_refused() {
        // The case this module exists for.
        let tmp = TempDir::new().expect("tmp");
        let root = tmp.path().join("shared");
        fs::create_dir_all(&root).expect("mkdir");
        let doc = write(&root, "doc.md", b"");
        write(tmp.path(), "outside/secret.png", b"\x89PNG");
        let scan = scan_document_images("![a](../outside/secret.png)", &doc, &root);
        assert!(scan.included.is_empty(), "leaked: {:?}", scan.included);
        assert_eq!(scan.skipped[0].reason, SkipReason::EscapesShareRoot);
    }

    #[test]
    fn an_absolute_src_is_refused_even_when_the_file_exists() {
        let tmp = TempDir::new().expect("tmp");
        let root = tmp.path().join("shared");
        fs::create_dir_all(&root).expect("mkdir");
        let doc = write(&root, "doc.md", b"");
        let outside = write(tmp.path(), "outside/secret.png", b"\x89PNG");
        let markdown = format!("![a]({})", outside.display());
        let scan = scan_document_images(&markdown, &doc, &root);
        assert!(scan.included.is_empty(), "leaked: {:?}", scan.included);
        assert_eq!(scan.skipped[0].reason, SkipReason::EscapesShareRoot);
    }

    #[test]
    fn an_encoded_separator_cannot_smuggle_a_traversal() {
        // `%2F` decodes to a separator before the path is opened, so it has to
        // be one while the traversal is being judged.
        let tmp = TempDir::new().expect("tmp");
        let root = tmp.path().join("shared");
        fs::create_dir_all(&root).expect("mkdir");
        let doc = write(&root, "doc.md", b"");
        write(tmp.path(), "outside/secret.png", b"\x89PNG");
        let scan = scan_document_images("![a](..%2Foutside%2Fsecret.png)", &doc, &root);
        assert!(scan.included.is_empty(), "leaked: {:?}", scan.included);
        assert_eq!(scan.skipped[0].reason, SkipReason::EscapesShareRoot);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_root_is_refused() {
        // Canonicalising first would report the TARGET as an ordinary file
        // inside the root and publish someone's private key as a png.
        let tmp = TempDir::new().expect("tmp");
        let root = tmp.path().join("shared");
        fs::create_dir_all(&root).expect("mkdir");
        let doc = write(&root, "doc.md", b"");
        let secret = write(tmp.path(), "outside/secret.png", b"\x89PNG");
        std::os::unix::fs::symlink(&secret, root.join("innocent.png")).expect("symlink");
        let scan = scan_document_images("![a](./innocent.png)", &doc, &root);
        assert!(scan.included.is_empty(), "leaked: {:?}", scan.included);
        assert_eq!(scan.skipped[0].reason, SkipReason::Symlink);
    }

    #[test]
    fn a_non_image_extension_is_refused() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        write(tmp.path(), "id_rsa", b"PRIVATE KEY");
        let scan = scan_document_images("![a](./id_rsa)", &doc, tmp.path());
        assert!(scan.included.is_empty());
        assert_eq!(scan.skipped[0].reason, SkipReason::NotAnImage);
    }

    #[test]
    fn an_oversize_image_is_refused() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        write(
            tmp.path(),
            "huge.png",
            &vec![0u8; (MAX_ASSET_BYTES + 1) as usize],
        );
        let scan = scan_document_images("![a](./huge.png)", &doc, tmp.path());
        assert!(scan.included.is_empty());
        assert_eq!(scan.skipped[0].reason, SkipReason::TooLarge);
    }

    #[test]
    fn a_missing_file_is_reported_not_published() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        let scan = scan_document_images("![a](./gone.png)", &doc, tmp.path());
        assert!(scan.included.is_empty());
        assert_eq!(scan.skipped[0].reason, SkipReason::Missing);
    }

    #[test]
    fn a_directory_named_like_an_image_is_refused() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        fs::create_dir_all(tmp.path().join("trap.png")).expect("mkdir");
        let scan = scan_document_images("![a](./trap.png)", &doc, tmp.path());
        assert!(scan.included.is_empty());
        assert_eq!(scan.skipped[0].reason, SkipReason::NotARegularFile);
    }

    #[test]
    fn the_count_budget_bounds_one_document() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        let mut markdown = String::new();
        for i in 0..(MAX_ASSET_COUNT + 5) {
            write(tmp.path(), &format!("img{i}.png"), b"\x89PNG");
            markdown.push_str(&format!("![a](./img{i}.png)\n\n"));
        }
        let scan = scan_document_images(&markdown, &doc, tmp.path());
        assert_eq!(scan.included.len(), MAX_ASSET_COUNT);
        assert_eq!(scan.skipped.len(), 5);
        assert!(
            scan.skipped
                .iter()
                .all(|s| s.reason == SkipReason::BudgetExhausted)
        );
    }

    #[test]
    fn a_percent_encoded_name_resolves_to_the_real_file() {
        let tmp = TempDir::new().expect("tmp");
        let doc = write(tmp.path(), "doc.md", b"");
        write(tmp.path(), "my shot.png", b"\x89PNG");
        let scan = scan_document_images("![a](./my%20shot.png)", &doc, tmp.path());
        assert_eq!(scan.included.len(), 1, "skipped: {:?}", scan.skipped);
        assert_eq!(scan.included[0].authored_src, "./my%20shot.png");
    }
}
