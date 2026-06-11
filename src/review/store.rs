//! Persistent local room store under the attn runtime directory
//! (`runtime_dir()/reviews/`). Owns on-disk layout for rooms, snapshots,
//! events, outbox, and sync cursors.
//!
//! Spec: `planning/collab/data-model.md` §Local Replicas and §Rust
//! Architecture Changes §Local Review Store. Implementation: issue
//! attn-nnj.2.3.
//!
//! Layout under `{runtime_dir}/reviews/`:
//!
//! ```text
//! rooms/<roomId>/
//!   room.json
//!   participants.json
//!   devices.json
//!   bindings.json
//!   snapshots/<snapshotId>.json
//!   events.jsonl       (append-only)
//!   outbox.jsonl       (append-only)
//!   cursors.json
//!   revisions/<fileId>.jsonl   (append-only, filled by attn-nnj.2.5)
//! ```
//!
//! Conventions:
//! - JSON state is written atomically via `<file>.tmp` + `rename`.
//! - JSONL logs are append-only (one record per line, `\n` terminator) and
//!   deduplicate on the appropriate id (`EventId` for events,
//!   `envelopeId` for outbox).
//! - Missing files surface as `Ok(None)` from `load_*` methods; directories
//!   are created lazily on save.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::runtime_dir;
use crate::review::ids::{FileId, RoomId, SnapshotId};
use crate::review::model::{
    Device, LocalFileBinding, LocalRevision, MailboxEnvelope, Participant, ReviewEvent, ReviewRoom,
    SnapshotNode, SyncCursor,
};

/// Persistent JSON+JSONL store for review rooms.
pub struct ReviewStore {
    root: PathBuf,
}

impl ReviewStore {
    /// Open (or create) the store at `{runtime_dir()}/reviews/`.
    ///
    /// Inherits the daemon's `ATTN_HOME` handling — when that env var is
    /// set, the store lives under it instead of `~/.attn`.
    pub fn open() -> Result<Self> {
        let root = runtime_dir()?.join("reviews");
        Self::open_at(root)
    }

    /// Open (or create) the store at an explicit path. Primarily for tests.
    pub fn open_at(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("could not create review store root {}", root.display()))?;
        Ok(Self { root })
    }

    /// Filesystem root of the store (`{runtime_dir}/reviews/`).
    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---------------------------------------------------------------------
    // Paths
    // ---------------------------------------------------------------------

    fn room_dir(&self, room_id: &RoomId) -> PathBuf {
        self.root.join("rooms").join(room_id_str(room_id))
    }

    fn room_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("room.json")
    }

    fn participants_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("participants.json")
    }

    fn devices_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("devices.json")
    }

    fn bindings_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("bindings.json")
    }

    fn cursor_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("cursors.json")
    }

    fn snapshot_file(&self, room_id: &RoomId, snapshot_id: &SnapshotId) -> PathBuf {
        self.room_dir(room_id)
            .join("snapshots")
            .join(format!("{}.json", snapshot_id_str(snapshot_id)))
    }

    fn events_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("events.jsonl")
    }

    fn outbox_file(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("outbox.jsonl")
    }

    fn revisions_dir(&self, room_id: &RoomId) -> PathBuf {
        self.room_dir(room_id).join("revisions")
    }

    fn revisions_file(&self, room_id: &RoomId, file_id: &FileId) -> PathBuf {
        self.revisions_dir(room_id)
            .join(format!("{}.jsonl", file_id_str(file_id)))
    }

    // ---------------------------------------------------------------------
    // Rooms
    // ---------------------------------------------------------------------

    /// Load `room.json` for a room. Returns `Ok(None)` if absent.
    pub fn load_room(&self, room_id: &RoomId) -> Result<Option<ReviewRoom>> {
        read_json(&self.room_file(room_id))
    }

    /// Atomically write `room.json` for a room.
    pub fn save_room(&self, room: &ReviewRoom) -> Result<()> {
        let dir = self.room_dir(&room.room_id);
        write_json_atomic(&dir, &dir.join("room.json"), room)
    }

    /// List all room ids that have an on-disk directory.
    pub fn list_rooms(&self) -> Result<Vec<RoomId>> {
        let rooms_dir = self.root.join("rooms");
        let mut out = Vec::new();
        let read_dir = match std::fs::read_dir(&rooms_dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(err) => {
                return Err(err).with_context(|| format!("could not read {}", rooms_dir.display()));
            }
        };
        for entry in read_dir {
            let entry = entry?;
            let ft = entry.file_type()?;
            if !ft.is_dir() {
                continue;
            }
            let name = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            out.push(deserialize_string_id::<RoomId>(&name)?);
        }
        out.sort_by_key(|id| room_id_str(id).to_string());
        Ok(out)
    }

    /// Remove all local state for a room. Missing rooms are a clean no-op.
    pub fn delete_room(&self, room_id: &RoomId) -> Result<()> {
        let dir = self.room_dir(room_id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| format!("could not remove {}", dir.display()));
            }
        }

        // Room secrets live outside `rooms/` so remove the matching secret
        // too; `local-shares.json` can tolerate stale metadata because
        // `list_rooms` is the source of truth for resumable rooms.
        let secret = self
            .root
            .join("shares")
            .join(format!("{}.secret", room_id_str(room_id)));
        match std::fs::remove_file(&secret) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| format!("could not remove {}", secret.display()));
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------------
    // Snapshots
    // ---------------------------------------------------------------------

    /// Load a single snapshot. Returns `Ok(None)` if absent.
    pub fn load_snapshot(
        &self,
        room_id: &RoomId,
        snapshot_id: &SnapshotId,
    ) -> Result<Option<SnapshotNode>> {
        read_json(&self.snapshot_file(room_id, snapshot_id))
    }

    /// Atomically write a single snapshot file.
    pub fn save_snapshot(&self, room_id: &RoomId, snapshot: &SnapshotNode) -> Result<()> {
        let dir = self.room_dir(room_id).join("snapshots");
        write_json_atomic(
            &dir,
            &self.snapshot_file(room_id, &snapshot.snapshot_id),
            snapshot,
        )
    }

    /// Iterate every `SnapshotNode` persisted for `room_id`. Yields decode
    /// errors so a corrupted file does not silently disappear; callers can
    /// fold them into their error channel.
    ///
    /// Returns an empty iterator when the room or its `snapshots/` directory
    /// is absent — same shape as `iter_events` / `iter_outbox`.
    pub fn iter_snapshots(&self, room_id: &RoomId) -> Result<Vec<Result<SnapshotNode>>> {
        let dir = self.room_dir(room_id).join("snapshots");
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => {
                return Err(err).with_context(|| format!("could not read {}", dir.display()));
            }
        };
        let mut out = Vec::new();
        for entry in read_dir {
            let entry = entry?;
            let ft = entry.file_type()?;
            if !ft.is_file() {
                continue;
            }
            // Only `.json` files in this directory are snapshot blobs; skip
            // anything else (e.g. a future sidecar index).
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let parsed: Result<Option<SnapshotNode>> = read_json(&path);
            match parsed {
                Ok(Some(node)) => out.push(Ok(node)),
                Ok(None) => {} // file vanished mid-iteration; ignore.
                Err(err) => out.push(Err(err)),
            }
        }
        Ok(out)
    }

    /// Return the most-recently-created `SnapshotNode` for `file_id` in
    /// `room_id`, or `Ok(None)` if no snapshot for that file is persisted.
    ///
    /// Ordering is by `SnapshotNode.created_at` (unix-ms), ties broken by
    /// `snapshot_id` lexicographically so the result is deterministic when
    /// two snapshots share the same timestamp.
    ///
    /// Used by `ReviewManager::handle_inbound_request_snapshot`
    /// (attn-nnj.7.6) to find the snapshot the owner should re-emit over
    /// the DataChannel when a peer asks for recovery.
    pub fn latest_snapshot_for_file(
        &self,
        room_id: &RoomId,
        file_id: &FileId,
    ) -> Result<Option<SnapshotNode>> {
        let mut best: Option<SnapshotNode> = None;
        for entry in self.iter_snapshots(room_id)? {
            let node = entry?;
            if node.file_id != *file_id {
                continue;
            }
            best = Some(match best {
                None => node,
                Some(prev) => {
                    if (node.created_at, snapshot_id_str(&node.snapshot_id))
                        > (prev.created_at, snapshot_id_str(&prev.snapshot_id))
                    {
                        node
                    } else {
                        prev
                    }
                }
            });
        }
        Ok(best)
    }

    // ---------------------------------------------------------------------
    // Snapshot blobs (decrypted plaintext bytes, keyed by envelopeId)
    // ---------------------------------------------------------------------

    fn blob_file(&self, room_id: &RoomId, envelope_id: &str) -> PathBuf {
        self.room_dir(room_id)
            .join("blobs")
            .join(format!("{envelope_id}.bin"))
    }

    /// Persist the decrypted plaintext of a `kind=snapshot_blob` envelope,
    /// keyed by the envelope's `envelopeId` — the wire-level identity the
    /// matching `SnapshotCreated` event references via
    /// `encryptedBlobRef.blobId`. Stored decrypted, consistent with
    /// `events.jsonl` (the local store is plaintext-at-rest by design).
    pub fn save_snapshot_blob(
        &self,
        room_id: &RoomId,
        envelope_id: &str,
        plaintext: &[u8],
    ) -> Result<()> {
        let path = self.blob_file(room_id, envelope_id);
        let dir = path
            .parent()
            .expect("blob_file always has a parent dir")
            .to_path_buf();
        write_bytes_atomic(&dir, &path, plaintext)
    }

    /// Load a previously persisted snapshot blob. Returns `Ok(None)` if
    /// absent — the blob envelope may not have arrived (yet).
    pub fn load_snapshot_blob(
        &self,
        room_id: &RoomId,
        envelope_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        let path = self.blob_file(room_id, envelope_id);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("could not read {}", path.display())),
        }
    }

    // ---------------------------------------------------------------------
    // Event log (append-only JSONL, dedup'd by EventId)
    // ---------------------------------------------------------------------

    /// Append a `ReviewEvent` to `events.jsonl`. Returns `Ok(true)` if newly
    /// written, `Ok(false)` if the `EventId` was already present (no write).
    pub fn append_event(&self, room_id: &RoomId, event: &ReviewEvent) -> Result<bool> {
        let path = self.events_file(room_id);
        let target = serde_json::to_value(&event.meta.event_id)
            .context("serialize event id for dedup scan")?;
        if jsonl_contains_id(&path, &["meta", "eventId"], &target)? {
            return Ok(false);
        }
        append_jsonl(&self.room_dir(room_id), &path, event)?;
        Ok(true)
    }

    /// Iterate every event in `events.jsonl`. The iterator yields decode
    /// errors as `Err`, leaving recovery up to the caller. Returns an empty
    /// iterator when the file is missing.
    pub fn iter_events(
        &self,
        room_id: &RoomId,
    ) -> Result<impl Iterator<Item = Result<ReviewEvent>>> {
        jsonl_iter(&self.events_file(room_id))
    }

    // ---------------------------------------------------------------------
    // Outbox (append-only JSONL, dedup'd by envelopeId)
    // ---------------------------------------------------------------------

    /// Append a `MailboxEnvelope` to `outbox.jsonl`. Returns `Ok(true)` if
    /// newly written, `Ok(false)` if the `envelopeId` was already present.
    pub fn append_outbox(&self, room_id: &RoomId, env: &MailboxEnvelope) -> Result<bool> {
        let path = self.outbox_file(room_id);
        let target = serde_json::Value::String(env.envelope_id.clone());
        if jsonl_contains_id(&path, &["envelopeId"], &target)? {
            return Ok(false);
        }
        append_jsonl(&self.room_dir(room_id), &path, env)?;
        Ok(true)
    }

    /// Iterate every envelope in `outbox.jsonl`. Empty iterator when absent.
    pub fn iter_outbox(
        &self,
        room_id: &RoomId,
    ) -> Result<impl Iterator<Item = Result<MailboxEnvelope>>> {
        jsonl_iter(&self.outbox_file(room_id))
    }

    // ---------------------------------------------------------------------
    // Revision journal (append-only JSONL, one file per FileId, no dedup).
    //
    // Per the issue spec: revisions are unique by `revision_id`, but the
    // store does NOT scan-and-dedup. Callers (`WorkingCopyService` + the
    // IPC handlers wired in attn-nnj.2.5) drive this once per successful
    // save and own the responsibility of not double-appending. This matches
    // the data-model.md §Local Replicas layout where the journal is the
    // restart-safe replay log for sync.
    // ---------------------------------------------------------------------

    /// Append a `LocalRevision` to `rooms/<roomId>/revisions/<fileId>.jsonl`.
    /// Creates the file (and parent directory) on first append.
    pub fn append_revision(
        &self,
        room_id: &RoomId,
        file_id: &FileId,
        revision: &LocalRevision,
    ) -> Result<()> {
        let path = self.revisions_file(room_id, file_id);
        append_jsonl(&self.revisions_dir(room_id), &path, revision)
    }

    /// Iterate every `LocalRevision` in a `(room, file)` journal. Returns an
    /// empty iterator when the file is missing — matching `iter_events` and
    /// `iter_outbox` so callers can treat "never written" the same as "empty".
    pub fn iter_revisions(
        &self,
        room_id: &RoomId,
        file_id: &FileId,
    ) -> Result<impl Iterator<Item = Result<LocalRevision>>> {
        jsonl_iter(&self.revisions_file(room_id, file_id))
    }

    // ---------------------------------------------------------------------
    // Cursors
    // ---------------------------------------------------------------------

    /// Load `cursors.json`. Returns `Ok(None)` if absent.
    pub fn load_cursor(&self, room_id: &RoomId) -> Result<Option<SyncCursor>> {
        read_json(&self.cursor_file(room_id))
    }

    /// Atomically write `cursors.json`.
    pub fn save_cursor(&self, room_id: &RoomId, cursor: &SyncCursor) -> Result<()> {
        let dir = self.room_dir(room_id);
        write_json_atomic(&dir, &self.cursor_file(room_id), cursor)
    }

    // ---------------------------------------------------------------------
    // Bindings
    // ---------------------------------------------------------------------

    /// Load `bindings.json`. Returns an empty map when absent.
    pub fn load_bindings(&self, room_id: &RoomId) -> Result<HashMap<FileId, LocalFileBinding>> {
        Ok(
            read_json::<HashMap<FileId, LocalFileBinding>>(&self.bindings_file(room_id))?
                .unwrap_or_default(),
        )
    }

    /// Atomically write `bindings.json`.
    pub fn save_bindings(
        &self,
        room_id: &RoomId,
        bindings: &HashMap<FileId, LocalFileBinding>,
    ) -> Result<()> {
        let dir = self.room_dir(room_id);
        write_json_atomic(&dir, &self.bindings_file(room_id), bindings)
    }

    // ---------------------------------------------------------------------
    // Participants + devices (room-level JSON snapshots; helpers for tests
    // and future ReviewManager use)
    // ---------------------------------------------------------------------

    /// Load `participants.json`. Returns `Ok(None)` if absent.
    pub fn load_participants(&self, room_id: &RoomId) -> Result<Option<Vec<Participant>>> {
        read_json(&self.participants_file(room_id))
    }

    /// Atomically write `participants.json`.
    pub fn save_participants(&self, room_id: &RoomId, participants: &[Participant]) -> Result<()> {
        let dir = self.room_dir(room_id);
        write_json_atomic(&dir, &self.participants_file(room_id), &participants)
    }

    /// Load `devices.json`. Returns `Ok(None)` if absent.
    pub fn load_devices(&self, room_id: &RoomId) -> Result<Option<Vec<Device>>> {
        read_json(&self.devices_file(room_id))
    }

    /// Atomically write `devices.json`.
    pub fn save_devices(&self, room_id: &RoomId, devices: &[Device]) -> Result<()> {
        let dir = self.room_dir(room_id);
        write_json_atomic(&dir, &self.devices_file(room_id), &devices)
    }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/// Atomically write `value` as pretty JSON to `path` via `<path>.tmp` +
/// `rename`. Creates `parent_dir` first if missing.
fn write_json_atomic<T: Serialize>(parent_dir: &Path, path: &Path, value: &T) -> Result<()> {
    std::fs::create_dir_all(parent_dir)
        .with_context(|| format!("could not create {}", parent_dir.display()))?;
    let bytes = serde_json::to_vec_pretty(value)
        .with_context(|| format!("serialize {}", path.display()))?;
    let tmp = with_tmp_suffix(path);
    {
        let mut f =
            File::create(&tmp).with_context(|| format!("could not create {}", tmp.display()))?;
        f.write_all(&bytes)
            .with_context(|| format!("could not write {}", tmp.display()))?;
        f.flush()
            .with_context(|| format!("could not flush {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("could not rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

fn write_bytes_atomic(parent_dir: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(parent_dir)
        .with_context(|| format!("could not create {}", parent_dir.display()))?;
    let tmp = with_tmp_suffix(path);
    {
        let mut f =
            File::create(&tmp).with_context(|| format!("could not create {}", tmp.display()))?;
        f.write_all(bytes)
            .with_context(|| format!("could not write {}", tmp.display()))?;
        f.flush()
            .with_context(|| format!("could not flush {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("could not rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

fn with_tmp_suffix(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    match path.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

/// Decode a JSON file. Returns `Ok(None)` if the file is missing.
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value = serde_json::from_slice(&bytes)
                .with_context(|| format!("decode JSON {}", path.display()))?;
            Ok(Some(value))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("could not read {}", path.display())),
    }
}

/// Append one JSON record + `\n` to a JSONL file. Creates `parent_dir` if
/// missing.
fn append_jsonl<T: Serialize>(parent_dir: &Path, path: &Path, value: &T) -> Result<()> {
    std::fs::create_dir_all(parent_dir)
        .with_context(|| format!("could not create {}", parent_dir.display()))?;
    let mut line = serde_json::to_string(value)
        .with_context(|| format!("serialize record for {}", path.display()))?;
    line.push('\n');
    let mut f = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .with_context(|| format!("could not open {}", path.display()))?;
    f.write_all(line.as_bytes())
        .with_context(|| format!("could not append to {}", path.display()))?;
    f.flush()
        .with_context(|| format!("could not flush {}", path.display()))?;
    Ok(())
}

/// Linear-scan a JSONL file for a record whose value at the given
/// dotted JSON path equals `target`. Missing file => `Ok(false)`.
fn jsonl_contains_id(path: &Path, json_path: &[&str], target: &serde_json::Value) -> Result<bool> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(err).with_context(|| format!("could not open {}", path.display()));
        }
    };
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.with_context(|| format!("could not read line from {}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            // Corrupt line: skip — caller will surface the iter-time error
            // when actually decoding records.
            Err(_) => continue,
        };
        let mut cursor = &value;
        let mut ok = true;
        for key in json_path {
            match cursor.get(*key) {
                Some(v) => cursor = v,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && cursor == target {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Iterate a JSONL file, decoding each non-blank line into `T`. Returns an
/// empty iterator when the file is missing.
fn jsonl_iter<T>(path: &Path) -> Result<JsonlIter<T>>
where
    T: for<'de> Deserialize<'de>,
{
    let reader = match File::open(path) {
        Ok(f) => Some(BufReader::new(f)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(err).with_context(|| format!("could not open {}", path.display()));
        }
    };
    Ok(JsonlIter {
        inner: reader.map(|r| r.lines()),
        path: path.to_path_buf(),
        _marker: std::marker::PhantomData,
    })
}

pub struct JsonlIter<T> {
    inner: Option<std::io::Lines<BufReader<File>>>,
    path: PathBuf,
    _marker: std::marker::PhantomData<fn() -> T>,
}

impl<T> Iterator for JsonlIter<T>
where
    T: for<'de> Deserialize<'de>,
{
    type Item = Result<T>;

    fn next(&mut self) -> Option<Self::Item> {
        let lines = self.inner.as_mut()?;
        loop {
            match lines.next()? {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed = serde_json::from_str::<T>(&line).with_context(|| {
                        format!("decode JSONL record from {}", self.path.display())
                    });
                    return Some(parsed);
                }
                Err(err) => {
                    return Some(Err(err).with_context(|| {
                        format!("could not read line from {}", self.path.display())
                    }));
                }
            }
        }
    }
}

/// Read the inner string out of a serde-newtype id (e.g. `RoomId(String)`)
/// without exposing the private field.
fn room_id_str(id: &RoomId) -> String {
    serialized_string_id(id).expect("RoomId always serializes to a string")
}

fn snapshot_id_str(id: &SnapshotId) -> String {
    serialized_string_id(id).expect("SnapshotId always serializes to a string")
}

fn file_id_str(id: &FileId) -> String {
    serialized_string_id(id).expect("FileId always serializes to a string")
}

fn serialized_string_id<T: Serialize>(id: &T) -> Option<String> {
    match serde_json::to_value(id).ok()? {
        serde_json::Value::String(s) => Some(s),
        _ => None,
    }
}

fn deserialize_string_id<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .with_context(|| format!("deserialize id from {s:?}"))
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::{
        ContentHash, DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId,
    };
    use crate::review::model::{
        AnchorIndex, CanonicalEncoding, EnvelopeKind, EventAuth, EventMeta, LocalRevision,
        MailboxEnvelope, ReviewEvent, ReviewEventBody, ReviewRoom, RevisionSource, RoomMode,
        RoomPolicy, SnapshotNode, SnapshotPlaintext, SyncCursor,
    };
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// Guard against parallel mutation of process-global `ATTN_HOME`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .expect("id deserializes from string")
    }

    fn sample_policy() -> RoomPolicy {
        RoomPolicy {
            mode: RoomMode::Async,
            max_peers: 8,
            max_snapshot_bytes: 5 * 1024 * 1024,
            max_event_bytes: 256 * 1024,
            max_events: 500,
            expires_at: 1_700_000_000_000,
            delete_events_after_owner_ack: false,
            allow_browser: false,
            allow_remote_agents: false,
        }
    }

    fn sample_room(room_id: &str) -> ReviewRoom {
        ReviewRoom {
            v: 2,
            room_id: id::<RoomId>(room_id),
            created_at: 1_700_000_000_001,
            created_by: id::<ParticipantId>("p-1"),
            policy: sample_policy(),
            documents: HashMap::new(),
            snapshots: HashMap::new(),
            event_heads: vec![],
        }
    }

    fn sample_meta(event_id: &str, room_id: &str) -> EventMeta {
        EventMeta {
            v: 2,
            event_id: id::<EventId>(event_id),
            room_id: id::<RoomId>(room_id),
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_002,
            parent_event_ids: vec![],
            snapshot_id: None,
        }
    }

    fn sample_auth() -> EventAuth {
        EventAuth {
            signature: "sig-base64url".to_string(),
            signing_key_id: "key-1".to_string(),
        }
    }

    fn sample_event(event_id: &str, room_id: &str) -> ReviewEvent {
        ReviewEvent {
            meta: sample_meta(event_id, room_id),
            body: ReviewEventBody::RoomCreated {
                room_id: id::<RoomId>(room_id),
                policy: sample_policy(),
                created_by: id::<ParticipantId>("p-1"),
            },
            auth: sample_auth(),
        }
    }

    fn sample_snapshot(snapshot_id: &str, file_id: &str) -> SnapshotNode {
        SnapshotNode {
            snapshot_id: id::<SnapshotId>(snapshot_id),
            file_id: id::<FileId>(file_id),
            parent_snapshot_id: None,
            supersedes_snapshot_id: None,
            created_at: 1_700_000_000_003,
            created_by: id::<ParticipantId>("p-1"),
            base_hash: id::<ContentHash>("hash-1"),
            byte_length: 42,
            encrypted_blob_ref: None,
            plaintext: Some(SnapshotPlaintext {
                markdown: "# hi\n".to_string(),
                anchor_index: AnchorIndex {
                    doc_hash: id::<ContentHash>("hash-1"),
                    canonical_encoding: CanonicalEncoding::Utf8Bytes,
                    line_count: 1,
                    blocks: vec![],
                    headings: vec![],
                },
            }),
        }
    }

    fn sample_envelope(envelope_id: &str, room_id: &str) -> MailboxEnvelope {
        MailboxEnvelope {
            v: 2,
            room_id: id::<RoomId>(room_id),
            envelope_id: envelope_id.to_string(),
            server_seq: None,
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_010,
            expires_at: 1_700_000_086_400,
            kind: EnvelopeKind::Event,
            target: None,
            nonce: "nonce".to_string(),
            ciphertext: "ct".to_string(),
            ciphertext_bytes: 16,
        }
    }

    fn sample_cursor(room_id: &str) -> SyncCursor {
        SyncCursor {
            room_id: id::<RoomId>(room_id),
            device_id: id::<DeviceId>("d-1"),
            last_pulled_seq: 7,
            imported_event_ids: vec![id::<EventId>("evt-1"), id::<EventId>("evt-2")],
            pending_outbound_envelope_ids: vec!["env-99".to_string()],
        }
    }

    fn sample_revision(revision_id: &str, parent: &str, next: &str) -> LocalRevision {
        LocalRevision {
            revision_id: revision_id.to_string(),
            parent_hash: id::<ContentHash>(parent),
            next_hash: id::<ContentHash>(next),
            created_at: 1_700_000_000_020,
            source: RevisionSource::ProsemirrorEdit,
            pm_steps: None,
            patch_text: None,
        }
    }

    fn fresh_store() -> (TempDir, ReviewStore) {
        let tmp = TempDir::new().expect("tempdir");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("open store");
        (tmp, store)
    }

    #[test]
    fn round_trip_review_room() {
        let (_tmp, store) = fresh_store();
        let room = sample_room("room-abc");

        store.save_room(&room).expect("save_room");
        let loaded = store.load_room(&room.room_id).expect("load_room");
        assert_eq!(loaded, Some(room.clone()));

        // Overwrite is atomic (no half-written tmp leftover).
        let mut updated = room.clone();
        updated.created_at = 1_700_000_000_999;
        store.save_room(&updated).expect("rewrite");
        let loaded = store.load_room(&room.room_id).expect("reload");
        assert_eq!(loaded, Some(updated));

        let tmp = store.room_file(&room.room_id).with_extension("json.tmp");
        assert!(!tmp.exists(), "tmp file must be cleaned up by rename");
    }

    #[test]
    fn snapshot_blob_round_trips_and_missing_is_none() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");

        assert_eq!(
            store
                .load_snapshot_blob(&room_id, "env-missing")
                .expect("load missing"),
            None
        );

        let bytes = vec![0xCDu8; 2048];
        store
            .save_snapshot_blob(&room_id, "env-1", &bytes)
            .expect("save blob");
        assert_eq!(
            store
                .load_snapshot_blob(&room_id, "env-1")
                .expect("load blob"),
            Some(bytes.clone())
        );

        // Overwrite is atomic and replaces the content.
        let bytes2 = vec![0xEFu8; 16];
        store
            .save_snapshot_blob(&room_id, "env-1", &bytes2)
            .expect("rewrite blob");
        assert_eq!(
            store
                .load_snapshot_blob(&room_id, "env-1")
                .expect("reload blob"),
            Some(bytes2)
        );
    }

    #[test]
    fn append_event_distinct_then_iter_returns_both() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");

        let a = sample_event("evt-1", "room-abc");
        let b = sample_event("evt-2", "room-abc");

        assert!(store.append_event(&room_id, &a).expect("append a"));
        assert!(store.append_event(&room_id, &b).expect("append b"));

        let events: Vec<ReviewEvent> = store
            .iter_events(&room_id)
            .expect("iter_events")
            .collect::<Result<_>>()
            .expect("decode events");
        assert_eq!(events, vec![a, b]);
    }

    #[test]
    fn append_event_dedup_by_event_id() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let event = sample_event("evt-dup", "room-abc");

        assert!(store.append_event(&room_id, &event).expect("first"));
        assert!(!store.append_event(&room_id, &event).expect("second"));

        let events: Vec<ReviewEvent> = store
            .iter_events(&room_id)
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], event);
    }

    #[test]
    fn round_trip_snapshot() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let snap = sample_snapshot("snap-1", "file-1");

        store.save_snapshot(&room_id, &snap).expect("save_snapshot");
        let loaded = store
            .load_snapshot(&room_id, &snap.snapshot_id)
            .expect("load_snapshot");
        assert_eq!(loaded, Some(snap));

        // Missing snapshot => Ok(None).
        let missing: SnapshotId = id("snap-missing");
        assert_eq!(
            store.load_snapshot(&room_id, &missing).expect("missing"),
            None
        );
    }

    #[test]
    fn round_trip_cursor() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let cursor = sample_cursor("room-abc");

        // Missing cursor => Ok(None).
        assert_eq!(store.load_cursor(&room_id).expect("missing"), None);

        store.save_cursor(&room_id, &cursor).expect("save_cursor");
        let loaded = store.load_cursor(&room_id).expect("load_cursor");
        assert_eq!(loaded, Some(cursor));
    }

    #[test]
    fn append_outbox_dedups_by_envelope_id() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let env_a = sample_envelope("env-1", "room-abc");
        let env_b = sample_envelope("env-2", "room-abc");

        assert!(store.append_outbox(&room_id, &env_a).expect("a"));
        assert!(!store.append_outbox(&room_id, &env_a).expect("a-dup"));
        assert!(store.append_outbox(&room_id, &env_b).expect("b"));

        let envs: Vec<MailboxEnvelope> = store
            .iter_outbox(&room_id)
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(envs, vec![env_a, env_b]);
    }

    #[test]
    fn round_trip_bindings() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");

        // Missing file => empty map.
        let initial = store.load_bindings(&room_id).expect("load empty");
        assert!(initial.is_empty());

        let mut bindings = HashMap::new();
        let file_id: FileId = id("file-1");
        bindings.insert(
            file_id.clone(),
            LocalFileBinding {
                file_id: file_id.clone(),
                absolute_path: "/tmp/foo.md".to_string(),
                project_root: "/tmp".to_string(),
            },
        );

        store.save_bindings(&room_id, &bindings).expect("save");
        let loaded = store.load_bindings(&room_id).expect("load");
        assert_eq!(loaded, bindings);
    }

    #[test]
    fn list_rooms_returns_all_room_dirs() {
        let (_tmp, store) = fresh_store();
        store.save_room(&sample_room("room-a")).expect("save a");
        store.save_room(&sample_room("room-b")).expect("save b");

        let rooms = store.list_rooms().expect("list_rooms");
        let names: Vec<String> = rooms.iter().map(room_id_str).collect();
        assert_eq!(names, vec!["room-a".to_string(), "room-b".to_string()]);
    }

    #[test]
    fn delete_room_removes_room_from_resume_list() {
        let (_tmp, store) = fresh_store();
        let room = sample_room("room-a");
        store.save_room(&room).expect("save room");

        assert_eq!(store.list_rooms().expect("before").len(), 1);
        store.delete_room(&room.room_id).expect("delete room");
        assert!(store.list_rooms().expect("after").is_empty());
        assert!(
            store
                .load_room(&room.room_id)
                .expect("load deleted")
                .is_none(),
            "deleted room should not load"
        );
    }

    #[test]
    fn open_honors_attn_home() {
        // Serialize against any other test that mutates ATTN_HOME, and
        // against the daemon's own env reads.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let tmp = TempDir::new().expect("tempdir");
        let prev = std::env::var("ATTN_HOME").ok();
        // SAFETY: tests are single-threaded under ENV_LOCK; daemon code
        // only reads ATTN_HOME, never writes it.
        unsafe {
            std::env::set_var("ATTN_HOME", tmp.path());
        }

        let store = ReviewStore::open().expect("open under ATTN_HOME");
        let room = sample_room("room-home");
        store.save_room(&room).expect("save under ATTN_HOME");

        let expected = tmp
            .path()
            .join("reviews")
            .join("rooms")
            .join("room-home")
            .join("room.json");
        assert!(
            expected.exists(),
            "expected room.json under ATTN_HOME at {}",
            expected.display()
        );

        unsafe {
            match prev {
                Some(v) => std::env::set_var("ATTN_HOME", v),
                None => std::env::remove_var("ATTN_HOME"),
            }
        }
    }

    // ---------------------------------------------------------------------
    // Revision journal (attn-nnj.2.5)
    // ---------------------------------------------------------------------

    #[test]
    fn append_revision_creates_file_with_single_line() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let file_id: FileId = id("file-1");
        let rev = sample_revision("rev-1", "h-prev", "h-next");

        store
            .append_revision(&room_id, &file_id, &rev)
            .expect("append");

        // File exists at the spec'd path.
        let path = store.revisions_file(&room_id, &file_id);
        assert!(path.exists(), "expected {}", path.display());

        // Exactly one record on disk.
        let collected: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_id)
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(collected, vec![rev]);
    }

    #[test]
    fn append_revision_preserves_order_across_appends() {
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let file_id: FileId = id("file-1");
        let rev_a = sample_revision("rev-a", "h0", "h1");
        let rev_b = sample_revision("rev-b", "h1", "h2");

        store
            .append_revision(&room_id, &file_id, &rev_a)
            .expect("append a");
        store
            .append_revision(&room_id, &file_id, &rev_b)
            .expect("append b");

        let collected: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_id)
            .expect("iter")
            .collect::<Result<_>>()
            .expect("decode");
        assert_eq!(collected, vec![rev_a, rev_b]);
    }

    #[test]
    fn revisions_are_partitioned_by_room() {
        // Two rooms each get their own journal for the same FileId string —
        // a write to one must not leak into the other.
        let (_tmp, store) = fresh_store();
        let room_a: RoomId = id("room-a");
        let room_b: RoomId = id("room-b");
        let file_id: FileId = id("file-shared");

        let rev_a = sample_revision("rev-a", "h0", "h1");
        let rev_b = sample_revision("rev-b", "h0", "h2");

        store
            .append_revision(&room_a, &file_id, &rev_a)
            .expect("append a");
        store
            .append_revision(&room_b, &file_id, &rev_b)
            .expect("append b");

        let in_a: Vec<LocalRevision> = store
            .iter_revisions(&room_a, &file_id)
            .expect("iter a")
            .collect::<Result<_>>()
            .expect("decode a");
        let in_b: Vec<LocalRevision> = store
            .iter_revisions(&room_b, &file_id)
            .expect("iter b")
            .collect::<Result<_>>()
            .expect("decode b");

        assert_eq!(in_a, vec![rev_a]);
        assert_eq!(in_b, vec![rev_b]);
    }

    #[test]
    fn revisions_are_partitioned_by_file_within_a_room() {
        // Distinct FileIds within the same room have independent journals.
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-abc");
        let file_one: FileId = id("file-1");
        let file_two: FileId = id("file-2");

        let rev_one = sample_revision("rev-one", "h0", "h1");
        let rev_two = sample_revision("rev-two", "h0", "h2");

        store
            .append_revision(&room_id, &file_one, &rev_one)
            .expect("append one");
        store
            .append_revision(&room_id, &file_two, &rev_two)
            .expect("append two");

        let in_one: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_one)
            .expect("iter one")
            .collect::<Result<_>>()
            .expect("decode one");
        let in_two: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_two)
            .expect("iter two")
            .collect::<Result<_>>()
            .expect("decode two");

        assert_eq!(in_one, vec![rev_one]);
        assert_eq!(in_two, vec![rev_two]);
    }

    #[test]
    fn iter_revisions_on_missing_file_returns_empty_iterator() {
        // Mirrors iter_events / iter_outbox: a never-written journal yields
        // Ok(iter) with zero items, not Err.
        let (_tmp, store) = fresh_store();
        let room_id: RoomId = id("room-empty");
        let file_id: FileId = id("file-never-written");

        let collected: Vec<LocalRevision> = store
            .iter_revisions(&room_id, &file_id)
            .expect("iter missing")
            .collect::<Result<_>>()
            .expect("decode missing");
        assert!(collected.is_empty());
    }
}
