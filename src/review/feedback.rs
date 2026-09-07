//! Provider-neutral projection of locally marked review comments.
//!
//! `events.jsonl` remains the source of comment content and lifecycle;
//! `bindings.json` remains the source of local file authority; and
//! `feedback-routing.json` is the private per-runtime routing overlay. This
//! module combines them without mutating any of those sources.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::review::anchors::{build_anchor_index, resolve_anchor};
use crate::review::crypto::ids::content_hash;
use crate::review::ids::{FileId, RoomId};
use crate::review::model::{
    Anchor, Participant, ParticipantKind, ResolvedAnchor, ReviewEvent, ReviewEventBody,
};
use crate::review::store::{FeedbackRoute, ReviewStore};

pub const FEEDBACK_SCHEMA: &str = "attn.feedback.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackFreshness {
    PersistedLocal,
    LiveLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackScope {
    pub requested_path: String,
    pub project_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSnapshot {
    pub schema: String,
    pub freshness: FeedbackFreshness,
    pub scope: FeedbackScope,
    pub feedback: Vec<FeedbackRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRecord {
    pub id: String,
    pub room_id: String,
    pub thread_id: String,
    pub root_event_id: String,
    pub file_id: String,
    pub feedback_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    pub author: FeedbackAuthor,
    pub created_at: u64,
    pub request: String,
    pub conversation: Vec<FeedbackMessage>,
    pub source: FeedbackSource,
    pub anchor: Anchor,
    pub anchor_resolution: FeedbackAnchorResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackAuthor {
    pub participant_id: String,
    pub display_name: String,
    pub kind: FeedbackAuthorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackAuthorKind {
    Owner,
    Reviewer,
    Agent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackMessage {
    pub event_id: String,
    pub author: FeedbackAuthor,
    pub created_at: u64,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSource {
    pub path: String,
    pub absolute_path: String,
    pub availability: FeedbackSourceAvailability,
    pub document_type: FeedbackDocumentType,
    pub snapshot_id: String,
    pub base_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackSourceAvailability {
    Local,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackDocumentType {
    Markdown,
    Html,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FeedbackAnchorResolution {
    Exact {
        confidence: f64,
        current_range: crate::review::model::PositionAnchor,
        reason: String,
    },
    Remapped {
        confidence: f64,
        current_range: crate::review::model::PositionAnchor,
        reason: String,
    },
    Ambiguous {
        candidates: Vec<crate::review::model::ResolvedAnchorCandidate>,
        reason: String,
    },
    Stale {
        reason: String,
    },
    ClientRequired {
        reason: String,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FeedbackStreamRecord {
    Snapshot {
        schema: String,
        cursor: u64,
        complete: bool,
        snapshot: FeedbackSnapshot,
    },
    Upsert {
        schema: String,
        cursor: u64,
        reason: String,
        feedback: FeedbackRecord,
    },
    Remove {
        schema: String,
        cursor: u64,
        reason: String,
        id: String,
        feedback_revision: u64,
    },
    Reset {
        schema: String,
        cursor: u64,
        reason: String,
        snapshot: FeedbackSnapshot,
    },
}

#[derive(Debug, Clone)]
struct SelectedBinding {
    room_id: RoomId,
    file_id: FileId,
    project_root: PathBuf,
    absolute_path: PathBuf,
    contained: bool,
}

#[derive(Debug)]
struct ScopeSelection {
    scope: FeedbackScope,
    bindings: Vec<SelectedBinding>,
}

/// Project one coherent, deterministic feedback snapshot from persisted data.
pub fn feedback_snapshot(
    store: &ReviewStore,
    requested_path: &Path,
    freshness: FeedbackFreshness,
) -> Result<FeedbackSnapshot> {
    let selection = resolve_scope(store, requested_path)?;
    let mut records = Vec::new();
    let mut room_bindings: BTreeMap<String, Vec<&SelectedBinding>> = BTreeMap::new();
    for binding in &selection.bindings {
        room_bindings
            .entry(binding.room_id.as_str().to_owned())
            .or_default()
            .push(binding);
    }

    for bindings in room_bindings.values() {
        let room_id = &bindings[0].room_id;
        let routing = store.load_feedback_routing(room_id)?;
        if !routing.threads.values().any(|route| route.marked) {
            continue;
        }
        let events = store.iter_events(room_id)?.collect::<Result<Vec<_>>>()?;
        let participants = participant_index(store, room_id, &events)?;
        let threads = reconstruct_comment_threads(events);
        let by_file = bindings
            .iter()
            .map(|binding| (binding.file_id.as_str(), *binding))
            .collect::<HashMap<_, _>>();

        for (thread_id, thread) in threads {
            let Some(route) = routing.threads.get(&thread_id).filter(|route| route.marked) else {
                continue;
            };
            if thread.resolved {
                continue;
            }
            let ReviewEventBody::CommentCreated { anchor, body, .. } = &thread.root.body else {
                continue;
            };
            let Some(binding) = by_file.get(anchor.file_id.as_str()).copied() else {
                continue;
            };
            records.push(project_record(
                room_id,
                &thread_id,
                route,
                &thread,
                binding,
                &participants,
                anchor,
                body,
            ));
        }
    }

    records.sort_by(|a, b| {
        a.source
            .path
            .cmp(&b.source.path)
            .then_with(|| a.anchor.position.byte_range[0].cmp(&b.anchor.position.byte_range[0]))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(FeedbackSnapshot {
        schema: FEEDBACK_SCHEMA.to_owned(),
        freshness,
        scope: selection.scope,
        feedback: records,
    })
}

#[derive(Debug)]
struct CommentThread {
    root: ReviewEvent,
    replies: Vec<ReviewEvent>,
    lifecycle: Vec<ReviewEvent>,
    resolved: bool,
}

fn reconstruct_comment_threads(events: Vec<ReviewEvent>) -> BTreeMap<String, CommentThread> {
    let mut ordered = events;
    ordered.sort_by(|a, b| {
        (a.meta.created_at, a.meta.event_id.as_str())
            .cmp(&(b.meta.created_at, b.meta.event_id.as_str()))
    });
    let mut comments: BTreeMap<String, Vec<ReviewEvent>> = BTreeMap::new();
    let mut lifecycle: BTreeMap<String, Vec<ReviewEvent>> = BTreeMap::new();
    for event in ordered {
        match &event.body {
            ReviewEventBody::CommentCreated { thread_id, .. } => {
                comments.entry(thread_id.clone()).or_default().push(event);
            }
            ReviewEventBody::CommentResolved { thread_id, .. } => {
                lifecycle.entry(thread_id.clone()).or_default().push(event);
            }
            ReviewEventBody::CommentReopened { thread_id, .. } => {
                lifecycle.entry(thread_id.clone()).or_default().push(event);
            }
            _ => {}
        }
    }
    comments
        .into_iter()
        .filter_map(|(thread_id, mut events)| {
            if events.is_empty() {
                return None;
            }
            let root = events.remove(0);
            let lifecycle = lifecycle.remove(&thread_id).unwrap_or_default();
            let resolved = lifecycle
                .last()
                .is_some_and(|event| matches!(event.body, ReviewEventBody::CommentResolved { .. }));
            Some((
                thread_id.clone(),
                CommentThread {
                    root,
                    replies: events,
                    lifecycle,
                    resolved,
                },
            ))
        })
        .collect()
}

fn participant_index(
    store: &ReviewStore,
    room_id: &RoomId,
    events: &[ReviewEvent],
) -> Result<HashMap<String, Participant>> {
    let mut out = store
        .load_participants(room_id)?
        .unwrap_or_default()
        .into_iter()
        .map(|participant| (participant.participant_id.as_str().to_owned(), participant))
        .collect::<HashMap<_, _>>();
    for event in events {
        if let ReviewEventBody::ParticipantJoined { participant, .. } = &event.body {
            out.insert(
                participant.participant_id.as_str().to_owned(),
                participant.clone(),
            );
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn project_record(
    room_id: &RoomId,
    thread_id: &str,
    route: &FeedbackRoute,
    thread: &CommentThread,
    binding: &SelectedBinding,
    participants: &HashMap<String, Participant>,
    anchor: &Anchor,
    body: &str,
) -> FeedbackRecord {
    let root_author = author_for(&thread.root, participants);
    let conversation = thread
        .replies
        .iter()
        .filter_map(|event| {
            let ReviewEventBody::CommentCreated { body, .. } = &event.body else {
                return None;
            };
            Some(FeedbackMessage {
                event_id: event.meta.event_id.as_str().to_owned(),
                author: author_for(event, participants),
                created_at: event.meta.created_at,
                body: body.clone(),
            })
        })
        .collect::<Vec<_>>();
    let human_followups = conversation
        .iter()
        .filter(|message| message.author.kind != FeedbackAuthorKind::Agent)
        .count() as u64;
    let lifecycle_transitions = thread.lifecycle.len() as u64;
    let (source, source_revision, anchor_resolution) = source_context(binding, anchor);
    FeedbackRecord {
        id: format!("{}:{thread_id}", room_id.as_str()),
        room_id: room_id.as_str().to_owned(),
        thread_id: thread_id.to_owned(),
        root_event_id: thread.root.meta.event_id.as_str().to_owned(),
        file_id: anchor.file_id.as_str().to_owned(),
        feedback_revision: route
            .revision
            .saturating_add(human_followups)
            .saturating_add(lifecycle_transitions),
        source_revision,
        author: root_author,
        created_at: thread.root.meta.created_at,
        request: body.to_owned(),
        conversation,
        source,
        anchor: anchor.clone(),
        anchor_resolution,
    }
}

fn author_for(event: &ReviewEvent, participants: &HashMap<String, Participant>) -> FeedbackAuthor {
    let participant_id = event.meta.author_id.as_str().to_owned();
    let Some(participant) = participants.get(&participant_id) else {
        return FeedbackAuthor {
            display_name: participant_id.clone(),
            participant_id,
            kind: FeedbackAuthorKind::Unknown,
        };
    };
    FeedbackAuthor {
        participant_id,
        display_name: participant.display_name.clone(),
        kind: match participant.kind {
            ParticipantKind::Owner => FeedbackAuthorKind::Owner,
            ParticipantKind::Reviewer => FeedbackAuthorKind::Reviewer,
            ParticipantKind::Agent => FeedbackAuthorKind::Agent,
        },
    }
}

fn source_context(
    binding: &SelectedBinding,
    anchor: &Anchor,
) -> (FeedbackSource, Option<String>, FeedbackAnchorResolution) {
    let document_type = if anchor.html.is_some() {
        FeedbackDocumentType::Html
    } else {
        FeedbackDocumentType::Markdown
    };
    if !binding.contained {
        return (
            FeedbackSource {
                path: binding.file_id.as_str().to_owned(),
                absolute_path: String::new(),
                availability: FeedbackSourceAvailability::Unreadable,
                document_type,
                snapshot_id: anchor.snapshot_id.as_str().to_owned(),
                base_hash: anchor.base_hash.as_str().to_owned(),
            },
            None,
            FeedbackAnchorResolution::Unavailable {
                reason: "bound source resolves outside its project root".to_owned(),
            },
        );
    }
    let relative = binding
        .absolute_path
        .strip_prefix(&binding.project_root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(path_for_output)
        .unwrap_or_else(|| path_for_output(&binding.absolute_path));
    let read = std::fs::read(&binding.absolute_path);
    let (availability, source_revision, resolution) = match read {
        Ok(bytes) if std::str::from_utf8(&bytes).is_err() => (
            FeedbackSourceAvailability::Unreadable,
            None,
            FeedbackAnchorResolution::Unavailable {
                reason: "local source is not valid UTF-8".to_owned(),
            },
        ),
        Ok(bytes) => {
            let hash = content_hash(&bytes);
            let hash_string = hash.as_str().to_owned();
            if document_type == FeedbackDocumentType::Html {
                (
                    FeedbackSourceAvailability::Local,
                    Some(hash_string),
                    FeedbackAnchorResolution::ClientRequired {
                        reason: "HTML selectors resolve in attn's document frame; rendered offsets are not source offsets".to_owned(),
                    },
                )
            } else {
                let resolution = build_anchor_index(&bytes, &anchor.snapshot_id)
                    .map_err(|error| error.to_string())
                    .and_then(|index| {
                        resolve_anchor(anchor, &index, &bytes, &hash, None)
                            .map_err(|error| error.to_string())
                    });
                (
                    FeedbackSourceAvailability::Local,
                    Some(hash_string),
                    match resolution {
                        Ok(value) => convert_resolution(value),
                        Err(reason) => FeedbackAnchorResolution::Unavailable { reason },
                    },
                )
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (
            FeedbackSourceAvailability::Missing,
            None,
            FeedbackAnchorResolution::Unavailable {
                reason: "bound local source file is missing".to_owned(),
            },
        ),
        Err(error) => (
            FeedbackSourceAvailability::Unreadable,
            None,
            FeedbackAnchorResolution::Unavailable {
                reason: format!("could not read bound local source: {error}"),
            },
        ),
    };
    (
        FeedbackSource {
            path: relative,
            absolute_path: path_for_output(&binding.absolute_path),
            availability,
            document_type,
            snapshot_id: anchor.snapshot_id.as_str().to_owned(),
            base_hash: anchor.base_hash.as_str().to_owned(),
        },
        source_revision,
        resolution,
    )
}

fn convert_resolution(resolution: ResolvedAnchor) -> FeedbackAnchorResolution {
    match resolution {
        ResolvedAnchor::Exact {
            confidence,
            current_range,
            reason,
        } => FeedbackAnchorResolution::Exact {
            confidence,
            current_range,
            reason: serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "exact".to_owned()),
        },
        ResolvedAnchor::Remapped {
            confidence,
            current_range,
            reason,
        } => FeedbackAnchorResolution::Remapped {
            confidence,
            current_range,
            reason: serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "remapped".to_owned()),
        },
        ResolvedAnchor::Ambiguous { candidates, reason } => {
            FeedbackAnchorResolution::Ambiguous { candidates, reason }
        }
        ResolvedAnchor::Stale { reason } => FeedbackAnchorResolution::Stale { reason },
    }
}

fn resolve_scope(store: &ReviewStore, requested_path: &Path) -> Result<ScopeSelection> {
    let requested = canonical_or_absolute(requested_path)?;
    let mut all = Vec::new();
    for room_id in store.list_rooms()? {
        for (file_id, binding) in store.load_bindings(&room_id)? {
            let project_root = canonical_or_absolute(Path::new(&binding.project_root))?;
            let absolute_path = canonical_or_absolute(Path::new(&binding.absolute_path))?;
            let contained = absolute_path.starts_with(&project_root);
            all.push(SelectedBinding {
                room_id: room_id.clone(),
                file_id,
                project_root,
                absolute_path,
                contained,
            });
        }
    }
    if all.is_empty() {
        bail!(
            "no local attn review bindings are available; share or import this project before reading feedback"
        );
    }

    let exact_file = all
        .iter()
        .filter(|binding| binding.contained && binding.absolute_path == requested)
        .map(|binding| binding.absolute_path.clone())
        .collect::<BTreeSet<_>>();
    let file_path = if exact_file.len() == 1 {
        exact_file.iter().next().cloned()
    } else {
        None
    };

    let roots = if file_path.is_some() {
        all.iter()
            .filter(|binding| binding.contained && binding.absolute_path == requested)
            .map(|binding| binding.project_root.clone())
            .collect::<BTreeSet<_>>()
    } else {
        let containing = all
            .iter()
            .filter(|binding| requested.starts_with(&binding.project_root))
            .map(|binding| binding.project_root.clone())
            .collect::<BTreeSet<_>>();
        if containing.is_empty() {
            all.iter()
                .filter(|binding| binding.project_root.starts_with(&requested))
                .map(|binding| binding.project_root.clone())
                .collect()
        } else {
            let deepest = containing
                .iter()
                .map(|root| root.components().count())
                .max()
                .unwrap_or(0);
            containing
                .into_iter()
                .filter(|root| root.components().count() == deepest)
                .collect()
        }
    };
    if roots.is_empty() {
        bail!(
            "{} is not mapped to a local attn review project",
            requested.display()
        );
    }
    if roots.len() != 1 {
        let display = roots
            .iter()
            .map(|path| path_for_output(path))
            .collect::<Vec<_>>()
            .join(", ");
        bail!(
            "{} matches multiple attn projects ({display}); pass one project or file path",
            requested.display()
        );
    }
    let project_root = roots.into_iter().next().expect("one root");
    let bindings = all
        .into_iter()
        .filter(|binding| {
            binding.project_root == project_root
                && file_path
                    .as_ref()
                    .is_none_or(|file| binding.absolute_path == *file)
        })
        .collect::<Vec<_>>();
    Ok(ScopeSelection {
        scope: FeedbackScope {
            requested_path: path_for_output(&requested),
            project_root: path_for_output(&project_root),
            file_path: file_path.map(|path| path_for_output(&path)),
        },
        bindings,
    })
}

fn canonical_or_absolute(path: &Path) -> Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    if path.is_absolute() {
        return Ok(path.to_owned());
    }
    Ok(std::env::current_dir()
        .context("could not read current directory")?
        .join(path))
}

fn path_for_output(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Human-readable default output. JSON mode serializes [`FeedbackSnapshot`]
/// directly; clipboard packets mirror this stable ordering and wording.
pub fn render_feedback(snapshot: &FeedbackSnapshot) -> String {
    let mut out = String::new();
    out.push_str("# attn feedback v1\n");
    out.push_str(&format!("Project: {}\n", snapshot.scope.project_root));
    out.push_str(&format!(
        "Freshness: {}\n",
        match snapshot.freshness {
            FeedbackFreshness::PersistedLocal => "persisted local",
            FeedbackFreshness::LiveLocal => "live local",
        }
    ));
    out.push_str("\nAddress this feedback in the available source files. Verify every quote against the current file before editing. Report changes and unresolved questions by feedback ID.\n");
    if snapshot.feedback.is_empty() {
        out.push_str("\nNo marked, unresolved feedback in this scope.\n");
        return out;
    }
    for (index, feedback) in snapshot.feedback.iter().enumerate() {
        if index > 0 {
            out.push_str("\n---\n");
        }
        out.push_str(&format!(
            "\n[{}] {}\nThread: {} · Revision: {} · Snapshot: {}\n",
            feedback.id,
            feedback.source.path,
            feedback.thread_id,
            feedback.feedback_revision,
            feedback.source.snapshot_id
        ));
        out.push_str(&format!(
            "Source: {} · {}\nAnchor: {}",
            feedback.source.absolute_path,
            match feedback.source.availability {
                FeedbackSourceAvailability::Local => "local",
                FeedbackSourceAvailability::Missing => "missing",
                FeedbackSourceAvailability::Unreadable => "unreadable",
            },
            resolution_label(&feedback.anchor_resolution)
        ));
        if let Some(html) = &feedback.anchor.html {
            out.push_str(&format!(" · selector {}", html.css_selector));
        } else {
            out.push_str(&format!(
                " · original lines {}-{}",
                feedback.anchor.position.line_range[0], feedback.anchor.position.line_range[1]
            ));
        }
        out.push('\n');
        if let Some(quote) = feedback
            .anchor
            .quote
            .as_ref()
            .map(|quote| quote.exact.trim())
            && !quote.is_empty()
        {
            out.push_str("\n> ");
            out.push_str(&quote.replace('\n', "\n> "));
            out.push('\n');
        }
        out.push_str(&format!(
            "\nRequest ({}): {}\n",
            feedback.author.display_name, feedback.request
        ));
        for reply in &feedback.conversation {
            out.push_str(&format!(
                "\nReply ({} · {:?}): {}\n",
                reply.author.display_name, reply.author.kind, reply.body
            ));
        }
    }
    out
}

fn resolution_label(resolution: &FeedbackAnchorResolution) -> &'static str {
    match resolution {
        FeedbackAnchorResolution::Exact { .. } => "exact",
        FeedbackAnchorResolution::Remapped { .. } => "remapped",
        FeedbackAnchorResolution::Ambiguous { .. } => "ambiguous",
        FeedbackAnchorResolution::Stale { .. } => "stale",
        FeedbackAnchorResolution::ClientRequired { .. } => "client required",
        FeedbackAnchorResolution::Unavailable { .. } => "unavailable",
    }
}

/// Compute stateful upserts/removals between two snapshots. Stream cursors are
/// assigned by the daemon after it establishes ordering.
pub fn diff_feedback(
    previous: &FeedbackSnapshot,
    current: &FeedbackSnapshot,
) -> (Vec<FeedbackRecord>, Vec<(String, u64, String)>) {
    let previous_by_id = previous
        .feedback
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect::<HashMap<_, _>>();
    let current_by_id = current
        .feedback
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect::<HashMap<_, _>>();
    let upserts = current
        .feedback
        .iter()
        .filter(|record| previous_by_id.get(record.id.as_str()).copied() != Some(*record))
        .cloned()
        .collect();
    let removals = previous
        .feedback
        .iter()
        .filter(|record| !current_by_id.contains_key(record.id.as_str()))
        .map(|record| {
            (
                record.id.clone(),
                record.feedback_revision.saturating_add(1),
                "no_longer_actionable".to_owned(),
            )
        })
        .collect();
    (upserts, removals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::ids::{DeviceId, EventId, ParticipantId, SnapshotId};
    use crate::review::model::{
        Capability, EventAuth, EventMeta, HtmlAnchor, HtmlAnchorContext, HtmlAnchorTarget,
        PositionAnchor,
    };
    use tempfile::TempDir;

    fn id<T: for<'de> Deserialize<'de>>(value: &str) -> T {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).expect("string id")
    }

    fn event(
        room_id: &RoomId,
        event_id: &str,
        author_id: &str,
        created_at: u64,
        body: ReviewEventBody,
    ) -> ReviewEvent {
        ReviewEvent {
            meta: EventMeta {
                v: 2,
                event_id: id::<EventId>(event_id),
                room_id: room_id.clone(),
                author_id: id::<ParticipantId>(author_id),
                device_id: id::<DeviceId>(&format!("device-{author_id}")),
                created_at,
                parent_event_ids: Vec::new(),
                snapshot_id: None,
            },
            body,
            auth: EventAuth {
                signature: "sig".to_owned(),
                signing_key_id: "key".to_owned(),
            },
        }
    }

    struct Fixture {
        _tmp: TempDir,
        store: ReviewStore,
        room_id: RoomId,
        path: PathBuf,
        anchor: Anchor,
    }

    fn fixture() -> Fixture {
        let tmp = TempDir::new().expect("tempdir");
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).expect("project dir");
        let path = project.join("plan.md");
        let source = b"# Plan\n\nKeep this sentence.\n";
        std::fs::write(&path, source).expect("source");
        let store = ReviewStore::open_at(tmp.path().join("reviews")).expect("store");
        let room_id: RoomId = id("room-feedback");
        let file_id: FileId = id("file-plan");
        let snapshot_id: SnapshotId = id("snap-plan");
        let hash = content_hash(source);
        let anchor = Anchor {
            v: 2,
            file_id: file_id.clone(),
            snapshot_id,
            base_hash: hash,
            position: PositionAnchor {
                byte_range: [8, 27],
                line_range: [3, 3],
                pm_range: None,
            },
            quote: None,
            block: None,
            context: None,
            structure: None,
            html: None,
        };
        let mut bindings = HashMap::new();
        bindings.insert(
            file_id.clone(),
            crate::review::model::LocalFileBinding {
                file_id,
                absolute_path: path.to_string_lossy().into_owned(),
                project_root: project.to_string_lossy().into_owned(),
            },
        );
        store.save_bindings(&room_id, &bindings).expect("bindings");
        store
            .save_participants(
                &room_id,
                &[
                    participant("p-owner", "Angus", ParticipantKind::Owner),
                    participant("p-reviewer", "Riley", ParticipantKind::Reviewer),
                    participant("p-agent", "Agent", ParticipantKind::Agent),
                ],
            )
            .expect("participants");
        store
            .append_event(
                &room_id,
                &event(
                    &room_id,
                    "event-root",
                    "p-owner",
                    1,
                    ReviewEventBody::CommentCreated {
                        thread_id: "thread-1".to_owned(),
                        anchor: anchor.clone(),
                        body: "Tighten this paragraph".to_owned(),
                    },
                ),
            )
            .expect("root event");
        store
            .set_feedback_mark(&room_id, "thread-1", true, 2)
            .expect("mark");
        Fixture {
            _tmp: tmp,
            store,
            room_id,
            path,
            anchor,
        }
    }

    fn participant(id_value: &str, name: &str, kind: ParticipantKind) -> Participant {
        Participant {
            participant_id: id(id_value),
            display_name: name.to_owned(),
            kind,
            public_signing_key: "key".to_owned(),
            capabilities: vec![Capability::WriteComment],
            color: None,
        }
    }

    #[test]
    fn projection_tracks_human_feedback_separately_from_source_changes() {
        let fixture = fixture();
        let initial = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("initial snapshot");
        assert_eq!(initial.feedback.len(), 1);
        assert_eq!(initial.feedback[0].feedback_revision, 1);
        assert!(matches!(
            initial.feedback[0].anchor_resolution,
            FeedbackAnchorResolution::Exact { .. }
        ));

        for (event_id, author, at, body) in [
            ("event-agent", "p-agent", 3, "I changed the paragraph"),
            ("event-human", "p-reviewer", 4, "Also keep the example"),
        ] {
            fixture
                .store
                .append_event(
                    &fixture.room_id,
                    &event(
                        &fixture.room_id,
                        event_id,
                        author,
                        at,
                        ReviewEventBody::CommentCreated {
                            thread_id: "thread-1".to_owned(),
                            anchor: fixture.anchor.clone(),
                            body: body.to_owned(),
                        },
                    ),
                )
                .expect("reply");
        }
        let replied =
            feedback_snapshot(&fixture.store, &fixture.path, FeedbackFreshness::LiveLocal)
                .expect("replied snapshot");
        assert_eq!(replied.feedback[0].feedback_revision, 2);
        assert_eq!(replied.feedback[0].conversation.len(), 2);

        std::fs::write(&fixture.path, b"# Plan\n\nKeep this revised sentence.\n").expect("edit");
        let edited = feedback_snapshot(&fixture.store, &fixture.path, FeedbackFreshness::LiveLocal)
            .expect("edited snapshot");
        assert_eq!(edited.feedback[0].feedback_revision, 2);
        assert_ne!(
            edited.feedback[0].source_revision,
            replied.feedback[0].source_revision
        );
        let (upserts, removals) = diff_feedback(&replied, &edited);
        assert_eq!(upserts.len(), 1);
        assert!(removals.is_empty());
    }

    #[test]
    fn resolved_or_unmarked_threads_are_removed_from_actionable_output() {
        let fixture = fixture();
        let initial = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("initial");
        fixture
            .store
            .append_event(
                &fixture.room_id,
                &event(
                    &fixture.room_id,
                    "event-resolve",
                    "p-owner",
                    3,
                    ReviewEventBody::CommentResolved {
                        thread_id: "thread-1".to_owned(),
                        resolved_by: id("p-owner"),
                    },
                ),
            )
            .expect("resolve");
        let resolved = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("resolved");
        assert!(resolved.feedback.is_empty());
        let (_, removals) = diff_feedback(&initial, &resolved);
        assert_eq!(removals[0].0, "room-feedback:thread-1");

        fixture
            .store
            .append_event(
                &fixture.room_id,
                &event(
                    &fixture.room_id,
                    "event-reopen",
                    "p-owner",
                    4,
                    ReviewEventBody::CommentReopened {
                        thread_id: "thread-1".to_owned(),
                        reopened_by: id("p-owner"),
                    },
                ),
            )
            .expect("reopen");
        let reopened = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("reopened");
        assert_eq!(reopened.feedback.len(), 1);
        assert_eq!(reopened.feedback[0].feedback_revision, 3);

        fixture
            .store
            .set_feedback_mark(&fixture.room_id, "thread-1", false, 5)
            .expect("unmark");
        let unmarked = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("unmarked");
        assert!(unmarked.feedback.is_empty());
    }

    #[test]
    fn scope_is_project_bounded_and_symlink_escapes_are_unavailable() {
        let fixture = fixture();
        let first_project = fixture.path.parent().expect("project root").to_path_buf();
        let nested = first_project.join("nested");
        std::fs::create_dir(&nested).expect("nested cwd");
        let nested_snapshot =
            feedback_snapshot(&fixture.store, &nested, FeedbackFreshness::PersistedLocal)
                .expect("nested project scope");
        assert_eq!(nested_snapshot.feedback.len(), 1);
        assert_eq!(nested_snapshot.feedback[0].id, "room-feedback:thread-1");

        let second_project = fixture._tmp.path().join("second project");
        std::fs::create_dir(&second_project).expect("second project");
        let second_path = second_project.join("plan two.md");
        let second_source = b"# Two\n\nSeparate source.\n";
        std::fs::write(&second_path, second_source).expect("second source");
        let second_room: RoomId = id("room-second");
        let second_file: FileId = id("file-second");
        fixture
            .store
            .save_bindings(
                &second_room,
                &HashMap::from([(
                    second_file.clone(),
                    crate::review::model::LocalFileBinding {
                        file_id: second_file.clone(),
                        absolute_path: second_path.to_string_lossy().into_owned(),
                        project_root: second_project.to_string_lossy().into_owned(),
                    },
                )]),
            )
            .expect("second binding");
        let mut second_anchor = fixture.anchor.clone();
        second_anchor.file_id = second_file;
        second_anchor.snapshot_id = id("snapshot-second");
        second_anchor.base_hash = content_hash(second_source);
        fixture
            .store
            .append_event(
                &second_room,
                &event(
                    &second_room,
                    "event-second",
                    "p-owner",
                    1,
                    ReviewEventBody::CommentCreated {
                        thread_id: "thread-second".to_owned(),
                        anchor: second_anchor,
                        body: "Only the second project sees this".to_owned(),
                    },
                ),
            )
            .expect("second event");
        fixture
            .store
            .set_feedback_mark(&second_room, "thread-second", true, 2)
            .expect("second mark");

        let first_only = feedback_snapshot(
            &fixture.store,
            &first_project,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("first project");
        assert_eq!(first_only.feedback.len(), 1);
        let second_only = feedback_snapshot(
            &fixture.store,
            &second_path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("exact second file");
        assert_eq!(second_only.feedback[0].id, "room-second:thread-second");
        assert!(
            feedback_snapshot(
                &fixture.store,
                fixture._tmp.path(),
                FeedbackFreshness::PersistedLocal,
            )
            .expect_err("shared ancestor must be ambiguous")
            .to_string()
            .contains("matches multiple attn projects")
        );

        let outside = fixture._tmp.path().join("outside.md");
        std::fs::write(&outside, b"private outside source").expect("outside source");
        let linked = first_project.join("linked.md");
        std::os::unix::fs::symlink(&outside, &linked).expect("escaped symlink");
        let escaped_room: RoomId = id("room-escaped");
        let escaped_file: FileId = id("file-escaped");
        fixture
            .store
            .save_bindings(
                &escaped_room,
                &HashMap::from([(
                    escaped_file.clone(),
                    crate::review::model::LocalFileBinding {
                        file_id: escaped_file.clone(),
                        absolute_path: linked.to_string_lossy().into_owned(),
                        project_root: first_project.to_string_lossy().into_owned(),
                    },
                )]),
            )
            .expect("escaped binding");
        let mut escaped_anchor = fixture.anchor.clone();
        escaped_anchor.file_id = escaped_file;
        escaped_anchor.snapshot_id = id("snapshot-escaped");
        fixture
            .store
            .append_event(
                &escaped_room,
                &event(
                    &escaped_room,
                    "event-escaped",
                    "p-owner",
                    1,
                    ReviewEventBody::CommentCreated {
                        thread_id: "thread-escaped".to_owned(),
                        anchor: escaped_anchor,
                        body: "Do not follow the symlink".to_owned(),
                    },
                ),
            )
            .expect("escaped event");
        fixture
            .store
            .set_feedback_mark(&escaped_room, "thread-escaped", true, 2)
            .expect("escaped mark");
        let with_escape = feedback_snapshot(
            &fixture.store,
            &first_project,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("project with escaped binding");
        let escaped = with_escape
            .feedback
            .iter()
            .find(|record| record.id == "room-escaped:thread-escaped")
            .expect("escaped record remains visible as unavailable");
        assert_eq!(
            escaped.source.availability,
            FeedbackSourceAvailability::Unreadable
        );
        assert!(escaped.source.absolute_path.is_empty());
        assert!(matches!(
            escaped.anchor_resolution,
            FeedbackAnchorResolution::Unavailable { ref reason }
                if reason.contains("outside its project root")
        ));
    }

    #[test]
    fn html_projection_names_rendered_selector_semantics() {
        let mut fixture = fixture();
        fixture.anchor.html = Some(HtmlAnchor {
            v: 1,
            target: HtmlAnchorTarget::Element,
            css_selector: "main > table > tbody > tr:nth-child(3)".to_owned(),
            fallback_selectors: Vec::new(),
            text_position: None,
            range: None,
            context: HtmlAnchorContext {
                tag_name: "tr".to_owned(),
                role: Some("row".to_owned()),
                scope_preview: "row 3".to_owned(),
                dom_path: vec!["main".to_owned(), "table".to_owned(), "tr".to_owned()],
            },
        });
        fixture
            .store
            .append_event(
                &fixture.room_id,
                &event(
                    &fixture.room_id,
                    "event-html",
                    "p-owner",
                    10,
                    ReviewEventBody::CommentCreated {
                        thread_id: "thread-html".to_owned(),
                        anchor: fixture.anchor.clone(),
                        body: "Clarify this row".to_owned(),
                    },
                ),
            )
            .expect("html comment");
        fixture
            .store
            .set_feedback_mark(&fixture.room_id, "thread-html", true, 11)
            .expect("html mark");
        let snapshot = feedback_snapshot(
            &fixture.store,
            &fixture.path,
            FeedbackFreshness::PersistedLocal,
        )
        .expect("html snapshot");
        let html = snapshot
            .feedback
            .iter()
            .find(|record| record.thread_id == "thread-html")
            .expect("html record");
        assert_eq!(html.source.document_type, FeedbackDocumentType::Html);
        assert!(matches!(
            html.anchor_resolution,
            FeedbackAnchorResolution::ClientRequired { .. }
        ));
        assert!(render_feedback(&snapshot).contains("selector main > table"));
    }
}
