//! Safe working-copy writes that record `LocalRevision`s and `ContentHash`es.
//! Replaces direct `std::fs::write` calls in IPC handlers so collaboration
//! state stays coherent.
//!
//! Spec: `planning/collab/data-model.md` §Working Copy Service.
//!
//! Canonical bytes rule (`crypto-spec.md` §ContentHash):
//! - UTF-8, no BOM.
//! - Normalize line endings to **LF** before hashing.
//! - Trailing-newline policy is preserved as authored — we hash whatever the
//!   user wrote (after LF normalization), we do NOT re-canonicalize through
//!   ProseMirror.
//!
//! Write-vs-hash split: the **bytes written to disk** preserve the user's
//! line endings exactly (so editors that round-trip CRLF don't see surprise
//! diffs), but the **bytes hashed** use LF for everything. This matches the
//! TypeScript counterpart's ContentHash derivation so two devices in
//! agreement on the document compute the same ContentHash regardless of how
//! their local OS spells newlines.

#![allow(dead_code)]

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::review::crypto::ids::content_hash;
use crate::review::ids::{ContentHash, EventId, RoomId};
use crate::review::model::{LocalRevision, RevisionSource};
use crate::review::watcher_state::SelfWriteTracker;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum WorkingCopyError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The caller passed `expected_hash` but the file on disk hashes to
    /// something else — a concurrent edit (or external write) happened
    /// between the caller's read and this save. The file is left untouched.
    #[error("expected hash {expected:?} but file is {actual:?}")]
    StaleHash {
        expected: ContentHash,
        actual: ContentHash,
    },
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/// One write the caller wants performed against a working copy.
#[derive(Debug, Clone)]
pub struct SaveRequest {
    pub path: PathBuf,
    pub content: String,
    /// If `Some`, the save fails with `StaleHash` when the on-disk content
    /// doesn't match. Used by the collab apply flow (issue attn-nnj.5.x) to
    /// detect concurrent edits before clobbering them.
    pub expected_hash: Option<ContentHash>,
    pub source: SaveSource,
}

/// Why this write is happening. Drives the `RevisionSource` recorded in the
/// returned `LocalRevision` so the caller can decide whether to journal it.
#[derive(Debug, Clone)]
pub enum SaveSource {
    /// Editor `edit_save` IPC — user typed in ProseMirror and hit save.
    UserEdit,
    /// Inline checkbox toggle from the rendered view (not a full edit).
    CheckboxToggle,
    /// Owner accepted a remote suggestion; the resulting write is attributed
    /// to the room + suggestion event for audit and event emission.
    AcceptedSuggestion {
        room_id: RoomId,
        suggestion_id: EventId,
    },
    /// File-watcher observed an external write (e.g. another editor saved
    /// the file). Not a write source — the caller (watcher) uses this when
    /// recording a `LocalRevision` so the revision journal sees the change.
    ExternalFileChange,
    /// A fresh snapshot was loaded from the store; the working copy was
    /// (re)written to match.
    SnapshotLoaded,
    /// User manually re-anchored a stale comment, which moved the cursor
    /// and produced a derivative write.
    ManualReanchor,
}

impl SaveSource {
    /// Translate to the wire-shape `RevisionSource` recorded in the
    /// `LocalRevision`. Several SaveSources collapse to the same
    /// `ProsemirrorEdit` because the journal cares about *how the content
    /// changed*, not *which UI surface triggered it*.
    fn to_revision_source(&self) -> RevisionSource {
        match self {
            SaveSource::UserEdit | SaveSource::CheckboxToggle | SaveSource::ManualReanchor => {
                RevisionSource::ProsemirrorEdit
            }
            SaveSource::AcceptedSuggestion { .. } => RevisionSource::AcceptedSuggestion,
            SaveSource::ExternalFileChange => RevisionSource::ExternalFileChange,
            SaveSource::SnapshotLoaded => RevisionSource::SnapshotLoaded,
        }
    }
}

/// What changed on disk after a successful `save`.
///
/// The `revision` here is NOT yet persisted — the caller (`ReviewManager`,
/// issue attn-nnj.2.5) decides whether to append it to the room's revision
/// journal. Decoupling lets non-collab writes (a `UserEdit` to a file that
/// isn't in any room) still flow through this service uniformly.
#[derive(Debug, Clone)]
pub struct SaveResult {
    pub previous_hash: ContentHash,
    pub next_hash: ContentHash,
    pub revision: LocalRevision,
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Working-copy writer. Held by `AppState` / `ReviewManager` once the latter
/// exists (issue attn-nnj.2.8); today callers can instantiate per-call
/// without losing correctness.
///
/// Shared state: an optional [`SelfWriteTracker`] that the file watcher
/// consults to distinguish daemon-originated writes from external edits
/// (issue attn-nnj.2.6). When the tracker is `None` (legacy callers,
/// unit tests that don't care) the service still hashes and writes the
/// file correctly — the watcher just won't be able to attribute the
/// event back to this save.
#[derive(Debug, Default)]
pub struct WorkingCopyService {
    self_write_tracker: Option<Arc<SelfWriteTracker>>,
}

impl WorkingCopyService {
    /// Construct without a tracker. Equivalent to
    /// [`WorkingCopyService::with_tracker(None)`].
    pub fn new() -> Self {
        Self {
            self_write_tracker: None,
        }
    }

    /// Construct with a shared [`SelfWriteTracker`]. The tracker is held by
    /// the daemon's main event loop alongside the file watcher; every
    /// successful save records `(path, next_hash)` so the watcher can drop
    /// the resulting `FsChanged` event instead of treating it as an
    /// external edit.
    pub fn with_tracker(tracker: Arc<SelfWriteTracker>) -> Self {
        Self {
            self_write_tracker: Some(tracker),
        }
    }

    /// Test/inspection helper: surface the shared tracker (if any) so
    /// callers can wire the same instance into the file watcher.
    pub fn self_write_tracker(&self) -> Option<&Arc<SelfWriteTracker>> {
        self.self_write_tracker.as_ref()
    }

    /// Atomic write: serialize to a `<path>.attn-tmp` sibling and `rename`
    /// into place. Records (but does not persist) a `LocalRevision`.
    ///
    /// `previous_hash` is the hash of the file *before* this call; if the
    /// file doesn't exist yet it's the hash of an empty byte string. The
    /// caller can use this together with `next_hash` to detect no-op writes
    /// or chain revisions.
    ///
    /// If `req.expected_hash` is `Some` and the current on-disk hash differs,
    /// this returns `StaleHash` and leaves the file untouched.
    pub fn save(&self, req: SaveRequest) -> Result<SaveResult, WorkingCopyError> {
        // 1. Read current bytes (if any) and compute previous_hash.
        let previous_bytes = match fs::read(&req.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let previous_hash = hash_canonical(&previous_bytes);

        // 2. Stale-hash guard. If the caller pinned an expected hash and the
        //    file has drifted, refuse to write.
        if let Some(expected) = req.expected_hash.as_ref()
            && expected != &previous_hash
        {
            return Err(WorkingCopyError::StaleHash {
                expected: expected.clone(),
                actual: previous_hash,
            });
        }

        // 3. Compute next_hash over the LF-normalized form of the new
        //    content. The on-disk bytes preserve the user's line endings.
        let next_hash = hash_canonical(req.content.as_bytes());

        // 4. Atomic write: temp file + rename. We use a sibling temp path so
        //    the rename is on the same filesystem (POSIX rename atomicity is
        //    only guaranteed within a filesystem).
        write_atomic(&req.path, req.content.as_bytes())?;

        // 4a. Tell the file watcher this write came from us so the resulting
        //     notify event doesn't get journaled as an ExternalFileChange.
        //     Done AFTER the rename so we never record an entry the
        //     filesystem hasn't yet observed.
        if let Some(tracker) = &self.self_write_tracker {
            tracker.record_self_write(req.path.clone(), next_hash.clone());
        }

        // 5. Build a LocalRevision describing the change. revision_id is a
        //    UUID-ish content-addressed string (parent_hash + next_hash + a
        //    timestamp) so it's deterministic per save attempt without
        //    needing a separate id allocator.
        let created_at = now_unix_millis();
        let revision = LocalRevision {
            revision_id: derive_revision_id(&previous_hash, &next_hash, created_at),
            parent_hash: previous_hash.clone(),
            next_hash: next_hash.clone(),
            created_at,
            source: req.source.to_revision_source(),
            // ProseMirror steps + patch text are populated by the caller
            // (issue attn-nnj.2.5 wires them through ReviewManager). Here
            // we record only the hash-level transition.
            pm_steps: None,
            patch_text: None,
        };

        Ok(SaveResult {
            previous_hash,
            next_hash,
            revision,
        })
    }

    /// Compute the canonical `ContentHash` for a file on disk — no write.
    /// LF-normalizes per the canonical bytes rule before hashing.
    pub fn hash_path(&self, path: &Path) -> Result<ContentHash, WorkingCopyError> {
        let bytes = fs::read(path)?;
        Ok(hash_canonical(&bytes))
    }

    /// Build a `LocalRevision` describing an externally-originated change
    /// to `path`. Reads the file, hashes it, and produces a revision with
    /// `source: ExternalFileChange`.
    ///
    /// `previous_hash` is the parent that the watcher believes was the
    /// last-known on-disk hash (the daemon should provide its last
    /// recorded hash here; for the simple case where we have no prior
    /// state we pass the empty hash). The returned revision is **not**
    /// persisted — the caller decides whether to journal it via
    /// [`crate::ipc::append_revision_if_mapped`].
    pub fn build_external_change_revision(
        &self,
        path: &Path,
        previous_hash: ContentHash,
    ) -> Result<LocalRevision, WorkingCopyError> {
        let next_hash = self.hash_path(path)?;
        let created_at = now_unix_millis();
        Ok(LocalRevision {
            revision_id: derive_revision_id(&previous_hash, &next_hash, created_at),
            parent_hash: previous_hash,
            next_hash,
            created_at,
            source: RevisionSource::ExternalFileChange,
            pm_steps: None,
            patch_text: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// LF-normalize `bytes` and hash via `content_hash`.
///
/// We strip `\r` before any `\n` (CRLF → LF) and leave lone `\r` alone
/// (legacy classic-Mac line endings aren't a thing for markdown today; we'd
/// rather not silently merge a `\r` and the next byte). This mirrors the
/// behavior the TypeScript canonicalizer needs to ship in `web/`.
fn hash_canonical(bytes: &[u8]) -> ContentHash {
    let normalized = normalize_lf(bytes);
    content_hash(&normalized)
}

/// Strip `\r` from every `\r\n` pair, leaving lone `\r` and lone `\n` alone.
/// Allocates only when the input contains CRLF — otherwise returns a copy of
/// the input (which is cheap relative to the SHA-256 we're about to do).
fn normalize_lf(bytes: &[u8]) -> Vec<u8> {
    // Fast path: no CR at all → no normalization needed.
    if !bytes.contains(&b'\r') {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            // Drop the \r; the \n will be pushed on the next iteration.
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Write `bytes` to `path` atomically via a sibling temp file + `rename`.
/// On rename success the temp file is gone; on early failure it may linger
/// — callers can sweep `*.attn-tmp` siblings if needed, but the test below
/// asserts the happy path leaves nothing behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = with_tmp_suffix(path);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        // Note: we deliberately do NOT fsync here — markdown files are
        // user-recoverable on crash, and fsync would add tens of ms to
        // every save. If a future bug shows partial writes surviving
        // crashes, revisit this trade-off.
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Build `<path>.attn-tmp` as a sibling temp path. Uses a distinct suffix
/// (not just `.tmp`) so we don't collide with other tools' temp files in
/// the same directory.
fn with_tmp_suffix(path: &Path) -> PathBuf {
    let mut name: OsString = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".attn-tmp");
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

/// Stable revision identifier derived from the (parent_hash, next_hash,
/// created_at) triple. Two callers with the same transition at the same
/// instant compute the same id, which matches the "content-addressed where
/// possible" rule in `crypto-spec.md` §ID Construction. Not a `RevisionId`
/// newtype because `LocalRevision.revision_id` is a plain `String` on the
/// wire (see `model.rs`).
fn derive_revision_id(previous: &ContentHash, next: &ContentHash, created_at: u64) -> String {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(b"attn local-revision v2");
    // Serialize the hashes the same way the wire form does — via serde —
    // so the id is invariant to internal representation changes.
    hasher.update(
        serde_json::to_string(previous)
            .unwrap_or_default()
            .as_bytes(),
    );
    hasher.update(serde_json::to_string(next).unwrap_or_default().as_bytes());
    hasher.update(created_at.to_string().as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

/// Wall-clock unix millis. Wrapped so tests can avoid pulling in `chrono`
/// and we don't sprinkle SystemTime arithmetic across the module.
fn now_unix_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture_path(dir: &TempDir, name: &str) -> PathBuf {
        dir.path().join(name)
    }

    fn read_to_bytes(path: &Path) -> Vec<u8> {
        fs::read(path).expect("read fixture")
    }

    #[test]
    fn save_writes_file_and_returns_matching_next_hash() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        let content = "# hello\n\nworld\n";
        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: content.to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save succeeds");

        // File on disk has the requested bytes (LF input, unchanged).
        assert_eq!(read_to_bytes(&path), content.as_bytes());

        // next_hash equals content_hash over LF-normalized bytes (same as
        // raw bytes here since input had no CRLF).
        let expected_hash = content_hash(content.as_bytes());
        assert_eq!(result.next_hash, expected_hash);
        assert_eq!(result.revision.next_hash, expected_hash);
        assert_eq!(result.revision.source, RevisionSource::ProsemirrorEdit);
    }

    #[test]
    fn save_with_matching_expected_hash_succeeds() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        // Seed the file via a first write.
        let first = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "first\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("first save");

        // Second write pins the expected hash to what we just wrote.
        let second = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "second\n".to_string(),
                expected_hash: Some(first.next_hash.clone()),
                source: SaveSource::UserEdit,
            })
            .expect("second save");

        assert_eq!(read_to_bytes(&path), b"second\n");
        assert_eq!(second.previous_hash, first.next_hash);
    }

    #[test]
    fn save_with_stale_expected_hash_returns_stale_hash_and_does_not_write() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        // Seed the file.
        svc.save(SaveRequest {
            path: path.clone(),
            content: "on disk\n".to_string(),
            expected_hash: None,
            source: SaveSource::UserEdit,
        })
        .expect("seed");

        // Compute a hash that does NOT match the file's current contents.
        let bogus = content_hash(b"something else entirely");

        let err = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "should not land".to_string(),
                expected_hash: Some(bogus.clone()),
                source: SaveSource::UserEdit,
            })
            .expect_err("save should fail with StaleHash");

        match err {
            WorkingCopyError::StaleHash { expected, actual } => {
                assert_eq!(expected, bogus);
                assert_ne!(actual, bogus);
            }
            other => panic!("expected StaleHash, got {other:?}"),
        }

        // File unchanged.
        assert_eq!(read_to_bytes(&path), b"on disk\n");
    }

    #[test]
    fn hash_path_matches_save_next_hash() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "hello\nworld\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save");

        let observed = svc.hash_path(&path).expect("hash_path");
        assert_eq!(observed, result.next_hash);
    }

    #[test]
    fn save_lf_normalizes_hash_but_preserves_disk_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        let crlf = "a\r\nb";
        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: crlf.to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save");

        // Disk preserves the CRLF the user authored.
        assert_eq!(read_to_bytes(&path), crlf.as_bytes());

        // Hash is over the LF-normalized form ("a\nb"), per crypto-spec.md.
        assert_eq!(result.next_hash, content_hash(b"a\nb"));
        // And not over the raw CRLF bytes.
        assert_ne!(result.next_hash, content_hash(crlf.as_bytes()));
    }

    #[test]
    fn save_leaves_no_tmp_file_behind() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        svc.save(SaveRequest {
            path: path.clone(),
            content: "hi\n".to_string(),
            expected_hash: None,
            source: SaveSource::UserEdit,
        })
        .expect("save");

        let tmp_sibling = with_tmp_suffix(&path);
        assert!(
            !tmp_sibling.exists(),
            "expected no .attn-tmp leftover at {}",
            tmp_sibling.display()
        );

        // Also confirm the directory has exactly one entry (the doc).
        let entries: Vec<_> = fs::read_dir(tmp.path())
            .expect("read_dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries, vec![OsString::from("doc.md")]);
    }

    #[test]
    fn previous_hash_chains_across_consecutive_saves() {
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();

        let first = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "one\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("first");

        let second = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "two\n".to_string(),
                expected_hash: None,
                source: SaveSource::CheckboxToggle,
            })
            .expect("second");

        // The second save's previous_hash MUST be the first save's next_hash.
        assert_eq!(second.previous_hash, first.next_hash);
        // And the second save's revision must point at the same parent.
        assert_eq!(second.revision.parent_hash, first.next_hash);
    }

    #[test]
    fn save_on_nonexistent_file_uses_empty_previous_hash() {
        // First-time saves (new file in a new room) should compute a
        // previous_hash over the empty byte string and still succeed.
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "fresh.md");
        let svc = WorkingCopyService::new();

        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "brand new\n".to_string(),
                expected_hash: None,
                source: SaveSource::SnapshotLoaded,
            })
            .expect("save");

        assert_eq!(result.previous_hash, content_hash(b""));
        assert_eq!(result.revision.source, RevisionSource::SnapshotLoaded);
    }

    #[test]
    fn save_source_accepted_suggestion_maps_to_revision_source() {
        // The AcceptedSuggestion variant carries room+suggestion ids; we
        // discard them when projecting to RevisionSource (the journal only
        // records the *kind* of change) but the caller can still see them
        // on the original SaveRequest.
        use serde_json::Value;
        fn id<T: for<'de> serde::Deserialize<'de>>(s: &str) -> T {
            serde_json::from_value(Value::String(s.to_string())).unwrap()
        }

        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();
        let result = svc
            .save(SaveRequest {
                path,
                content: "applied\n".to_string(),
                expected_hash: None,
                source: SaveSource::AcceptedSuggestion {
                    room_id: id::<RoomId>("room-abc"),
                    suggestion_id: id::<EventId>("evt-1"),
                },
            })
            .expect("save");
        assert_eq!(result.revision.source, RevisionSource::AcceptedSuggestion);
    }

    #[test]
    fn revision_id_is_stable_for_same_inputs() {
        let prev = content_hash(b"prev");
        let next = content_hash(b"next");
        let a = derive_revision_id(&prev, &next, 42);
        let b = derive_revision_id(&prev, &next, 42);
        assert_eq!(a, b, "revision_id derivation must be deterministic");
        assert_ne!(a, derive_revision_id(&prev, &next, 43));
    }

    #[test]
    fn save_records_to_self_write_tracker_when_attached() {
        // Wire a tracker into the service, save twice, and confirm each
        // (path, next_hash) is consumable from the tracker. This is the
        // primary contract for attn-nnj.2.6 — the watcher relies on the
        // tracker being populated synchronously with every successful
        // write.
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let tracker = std::sync::Arc::new(SelfWriteTracker::new());
        let svc = WorkingCopyService::with_tracker(tracker.clone());

        let first = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "one\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("first save");
        assert!(
            tracker.consume_match(&path, &first.next_hash),
            "tracker must contain first save's (path, hash)"
        );

        let second = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "two\n".to_string(),
                expected_hash: None,
                source: SaveSource::CheckboxToggle,
            })
            .expect("second save");
        assert!(
            tracker.consume_match(&path, &second.next_hash),
            "tracker must contain second save's (path, hash)"
        );
    }

    #[test]
    fn save_without_tracker_still_succeeds() {
        // Legacy path: WorkingCopyService::new() has no tracker; the save
        // must still write atomically and return a valid SaveResult.
        let tmp = TempDir::new().unwrap();
        let path = fixture_path(&tmp, "doc.md");
        let svc = WorkingCopyService::new();
        let result = svc
            .save(SaveRequest {
                path: path.clone(),
                content: "no tracker\n".to_string(),
                expected_hash: None,
                source: SaveSource::UserEdit,
            })
            .expect("save without tracker");
        assert_eq!(result.next_hash, content_hash(b"no tracker\n"));
        assert!(svc.self_write_tracker().is_none());
    }

    #[test]
    fn normalize_lf_handles_mixed_endings() {
        // CRLF collapses; lone CR and lone LF are preserved as-is.
        assert_eq!(normalize_lf(b"a\r\nb"), b"a\nb");
        assert_eq!(normalize_lf(b"a\rb"), b"a\rb"); // lone CR untouched
        assert_eq!(normalize_lf(b"a\nb"), b"a\nb"); // pure LF untouched
        assert_eq!(
            normalize_lf(b"a\r\nb\r\nc\n"),
            b"a\nb\nc\n",
            "multiple CRLF pairs all collapse"
        );
        // No CR at all: zero-allocation fast path still returns correct bytes.
        assert_eq!(normalize_lf(b"plain"), b"plain");
    }
}
