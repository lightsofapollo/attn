//! Shared state the file watcher uses to distinguish daemon self-writes from
//! external changes.
//!
//! Spec: `planning/collab/data-model.md` §File Watcher Integration.
//!
//! When [`crate::review::working_copy::WorkingCopyService`] writes a file it
//! pushes `(path, next_hash)` into a [`SelfWriteTracker`]. The file watcher
//! receives the resulting `FsChanged` event, hashes the new on-disk bytes,
//! and consults the tracker:
//!
//! - **Hit** (path+hash match): a self-write — drop on the floor. The save
//!   flow already recorded the [`LocalRevision`](crate::review::model::LocalRevision)
//!   via the IPC handler.
//! - **Miss**: an external editor changed the file. The watcher records a
//!   `LocalRevision { source: ExternalFileChange }` and persists it through
//!   the same `persist_revision_if_mapped` path the IPC handlers use.
//!
//! Entries auto-expire after [`SelfWriteTracker::DEFAULT_TTL`] (5 s) so the
//! set can't grow unbounded if the watcher happens to drop or coalesce an
//! event. `notify` normally fires within milliseconds; 5 s is enormous head
//! room while still being short enough that two unrelated identical saves
//! seconds apart don't blur into one another.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::review::ids::ContentHash;

/// TTL-tracked recent self-writes: `(path, hash, time-of-write)`.
///
/// Lookups are O(N) over the entries but N is bounded by the in-flight save
/// rate over a 5-second window — well under 100 in realistic use. Keeping the
/// data structure trivial means there is no race window where a self-write
/// gets recorded after the watcher has already consulted the tracker (which
/// would happen if we used a more elaborate index keyed on an `Arc`).
#[derive(Debug)]
pub struct SelfWriteTracker {
    entries: Mutex<Vec<Entry>>,
    ttl: Duration,
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    hash: ContentHash,
    recorded_at: Instant,
}

impl Default for SelfWriteTracker {
    fn default() -> Self {
        Self::with_ttl(Self::DEFAULT_TTL)
    }
}

impl SelfWriteTracker {
    /// Default TTL for recent self-writes. 5 s is plenty — `notify` events
    /// fire within milliseconds in normal operation and even a sluggish CI
    /// host should not exceed a second.
    pub const DEFAULT_TTL: Duration = Duration::from_secs(5);

    /// Build a tracker with the [`DEFAULT_TTL`](Self::DEFAULT_TTL).
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a tracker with a custom TTL. Used by tests to make expiry
    /// observable without sleeping.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            ttl,
        }
    }

    /// Called immediately after a successful
    /// [`WorkingCopyService::save`](crate::review::working_copy::WorkingCopyService::save).
    ///
    /// Lazily prunes expired entries on the way in so the vec doesn't grow
    /// without bound even if `prune` is never called from a ticker.
    pub fn record_self_write(&self, path: PathBuf, hash: ContentHash) {
        self.record_at(path, hash, Instant::now());
    }

    /// Test-friendly variant of [`record_self_write`] that takes an explicit
    /// `recorded_at` instant so tests can synthesize an entry deep in the
    /// past without sleeping.
    fn record_at(&self, path: PathBuf, hash: ContentHash, recorded_at: Instant) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        prune_in_place(&mut entries, self.ttl, Instant::now());
        entries.push(Entry {
            path,
            hash,
            recorded_at,
        });
    }

    /// Called from the watcher on `FsChanged`. Returns `true` if this
    /// `(path, hash)` matches a recent self-write (and removes the matching
    /// entry, so a second call for the same write returns `false`).
    ///
    /// Comparison is exact-match on both `path` and `hash`. If a user
    /// happens to externally edit the file to the same bytes the daemon was
    /// about to write, the external change collapses into the self-write —
    /// which is what we want (the journal entry was already recorded).
    pub fn consume_match(&self, path: &Path, hash: &ContentHash) -> bool {
        self.consume_match_at(path, hash, Instant::now())
    }

    /// Test-friendly variant of [`consume_match`] using an explicit `now`.
    fn consume_match_at(&self, path: &Path, hash: &ContentHash, now: Instant) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        prune_in_place(&mut entries, self.ttl, now);
        // First-match-wins by insertion order. If callers somehow record two
        // saves with the same (path, hash) within the TTL, draining the
        // oldest first matches the FIFO nature of `notify` events.
        if let Some(idx) = entries
            .iter()
            .position(|e| e.path == path && &e.hash == hash)
        {
            entries.swap_remove(idx);
            true
        } else {
            false
        }
    }

    /// Periodic cleanup — call from a background ticker (the daemon does
    /// this every ~10 s) or whenever we know the set might have stale
    /// entries. Idempotent; safe to call at any rate.
    pub fn prune(&self) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        prune_in_place(&mut entries, self.ttl, Instant::now());
    }

    /// Test-only window into the live entry count after pruning. The
    /// `cfg(test)` gate keeps this out of the public surface.
    #[cfg(test)]
    fn len_after_prune(&self) -> usize {
        let Ok(mut entries) = self.entries.lock() else {
            return 0;
        };
        prune_in_place(&mut entries, self.ttl, Instant::now());
        entries.len()
    }
}

fn prune_in_place(entries: &mut Vec<Entry>, ttl: Duration, now: Instant) {
    entries.retain(|e| now.duration_since(e.recorded_at) < ttl);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::crypto::ids::content_hash;

    fn h(bytes: &[u8]) -> ContentHash {
        content_hash(bytes)
    }

    #[test]
    fn record_and_consume_matches_exactly_once() {
        let tracker = SelfWriteTracker::new();
        let path = PathBuf::from("/tmp/doc.md");
        let hash = h(b"hello");

        tracker.record_self_write(path.clone(), hash.clone());
        assert!(
            tracker.consume_match(&path, &hash),
            "first consume should hit"
        );
        assert!(
            !tracker.consume_match(&path, &hash),
            "entry must be consumed and not match a second time"
        );
    }

    #[test]
    fn consume_match_for_unrecorded_pair_returns_false() {
        let tracker = SelfWriteTracker::new();
        assert!(
            !tracker.consume_match(&PathBuf::from("/tmp/missing.md"), &h(b"nope")),
            "empty tracker must never match"
        );
    }

    #[test]
    fn consume_match_for_matching_path_but_different_hash_returns_false() {
        // Two writes can arrive with the same path but distinct contents
        // (e.g. daemon was about to write hash A, but vim already wrote
        // hash B in between). The external write must NOT be swallowed.
        let tracker = SelfWriteTracker::new();
        let path = PathBuf::from("/tmp/race.md");
        tracker.record_self_write(path.clone(), h(b"daemon-content"));

        assert!(
            !tracker.consume_match(&path, &h(b"external-content")),
            "different hash on same path must not consume the self-write entry"
        );

        // And the original entry is still available for the matching event
        // that eventually arrives.
        assert!(
            tracker.consume_match(&path, &h(b"daemon-content")),
            "the genuine self-write match should still fire"
        );
    }

    #[test]
    fn consume_match_for_matching_hash_but_different_path_returns_false() {
        // Two unrelated files happening to share the same content hash
        // shouldn't cross-pollinate. (Rare in practice; load-bearing for
        // monorepos with templated files.)
        let tracker = SelfWriteTracker::new();
        let hash = h(b"# README\n");
        tracker.record_self_write(PathBuf::from("/tmp/a/README.md"), hash.clone());

        assert!(
            !tracker.consume_match(&PathBuf::from("/tmp/b/README.md"), &hash),
            "different path must not consume an unrelated entry"
        );
    }

    #[test]
    fn entries_expire_after_ttl_and_consume_misses() {
        // Use a short TTL and synthesize an entry recorded in the past.
        let tracker = SelfWriteTracker::with_ttl(Duration::from_millis(50));
        let path = PathBuf::from("/tmp/old.md");
        let hash = h(b"aged");

        let long_ago = Instant::now() - Duration::from_secs(60);
        tracker.record_at(path.clone(), hash.clone(), long_ago);

        // record_at still pushes the entry (pruning ran for OTHER entries
        // first, but our synthetic record is younger-than-its-instant in
        // wall-clock terms). consume_match then prunes against `now`,
        // which should evict our aged entry before scanning.
        assert!(
            !tracker.consume_match(&path, &hash),
            "expired entries must not match"
        );
    }

    #[test]
    fn prune_removes_expired_entries() {
        let tracker = SelfWriteTracker::with_ttl(Duration::from_millis(10));
        let long_ago = Instant::now() - Duration::from_secs(60);

        tracker.record_at(PathBuf::from("/tmp/a.md"), h(b"a"), long_ago);
        tracker.record_at(PathBuf::from("/tmp/b.md"), h(b"b"), long_ago);
        // Fresh entry survives.
        tracker.record_at(PathBuf::from("/tmp/c.md"), h(b"c"), Instant::now());

        tracker.prune();
        assert_eq!(
            tracker.len_after_prune(),
            1,
            "expected only the fresh entry to remain"
        );
        assert!(tracker.consume_match(&PathBuf::from("/tmp/c.md"), &h(b"c")));
    }

    #[test]
    fn multiple_distinct_entries_coexist_until_each_matches() {
        // Several saves in flight at once: each (path, hash) must match
        // its own corresponding event, independently of arrival order.
        let tracker = SelfWriteTracker::new();
        let entries = [
            (PathBuf::from("/tmp/a.md"), h(b"a")),
            (PathBuf::from("/tmp/b.md"), h(b"b")),
            (PathBuf::from("/tmp/c.md"), h(b"c")),
        ];
        for (p, hash) in &entries {
            tracker.record_self_write(p.clone(), hash.clone());
        }

        // Consume in reverse arrival order.
        assert!(tracker.consume_match(&entries[2].0, &entries[2].1));
        assert!(tracker.consume_match(&entries[0].0, &entries[0].1));
        assert!(tracker.consume_match(&entries[1].0, &entries[1].1));

        // All consumed.
        assert_eq!(tracker.len_after_prune(), 0);
    }

    #[test]
    fn duplicate_records_each_consume_independently() {
        // If the same (path, hash) is recorded twice (back-to-back identical
        // saves), each gets its own consume slot. This matches how `notify`
        // would emit two events for two writes.
        let tracker = SelfWriteTracker::new();
        let path = PathBuf::from("/tmp/twice.md");
        let hash = h(b"same");
        tracker.record_self_write(path.clone(), hash.clone());
        tracker.record_self_write(path.clone(), hash.clone());

        assert!(tracker.consume_match(&path, &hash));
        assert!(tracker.consume_match(&path, &hash));
        assert!(!tracker.consume_match(&path, &hash));
    }
}
