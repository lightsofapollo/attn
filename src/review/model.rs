//! Serde types for rooms, participants, snapshots, events, envelopes, and
//! sync cursors that make up the review domain wire/storage format.
//!
//! Spec: `planning/collab/data-model.md` §Terms, §Snapshot Graph,
//! §Review Events, §Encrypted Envelopes, §Sync Cursors And ACKs.
//! Amendments: `planning/collab/amendments.md` decisions #11, #12, #14, #16.
//!
//! Wire/storage rules:
//! - Every struct serializes with `camelCase` JSON keys so payloads round-trip
//!   byte-identical between Rust and the TypeScript counterpart in
//!   `web/src/lib/types.ts`.
//! - `ReviewEventBody` is a tagged enum keyed by `type` so a single JSON
//!   stream of events can be parsed without an out-of-band discriminator.
//! - `Option<T>` fields use `#[serde(skip_serializing_if = "Option::is_none")]`
//!   so absent fields are OMITTED, never emitted as `null` (matches the
//!   canonical-JSON rule in `crypto-spec.md`).
//! - Opaque binary payloads (signatures, nonces, ciphertext) are carried as
//!   `String` (base64url). Unix-millisecond timestamps are `u64`.

#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::review::ids::{
    ContentHash, DeviceId, EventId, FileId, ParticipantId, RoomId, SnapshotId,
};

// ---------------------------------------------------------------------------
// Review room + policy
// ---------------------------------------------------------------------------

/// Capability-scoped collaboration space.
///
/// Spec: `data-model.md` §Review Room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRoom {
    pub v: u32,
    pub room_id: RoomId,
    pub created_at: u64,
    pub created_by: ParticipantId,
    pub policy: RoomPolicy,
    pub documents: HashMap<FileId, SharedDocument>,
    pub snapshots: HashMap<SnapshotId, SnapshotNode>,
    pub event_heads: Vec<EventId>,
}

/// Room-level capability and lifecycle policy enforced by the relay.
///
/// Spec: `data-model.md` §Review Room. Default for `deleteEventsAfterOwnerAck`
/// per `amendments.md` decision #12 is `false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPolicy {
    pub mode: RoomMode,
    pub max_peers: u32,
    pub max_snapshot_bytes: u64,
    pub max_event_bytes: u64,
    pub max_events: u32,
    pub expires_at: u64,
    pub delete_events_after_owner_ack: bool,
    pub allow_browser: bool,
    pub allow_remote_agents: bool,
}

/// Room operating mode.
///
/// Spec: `data-model.md` §Product Modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomMode {
    Live,
    Async,
    Hybrid,
}

// ---------------------------------------------------------------------------
// Participants + devices
// ---------------------------------------------------------------------------

/// Person or agent participating in a review room.
///
/// Spec: `data-model.md` §Participant And Device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub participant_id: ParticipantId,
    pub display_name: String,
    pub kind: ParticipantKind,
    pub public_signing_key: String,
    pub capabilities: Vec<Capability>,
}

/// Participant kind.
///
/// Spec: `data-model.md` §Participant And Device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantKind {
    Owner,
    Reviewer,
    Agent,
}

/// One installed client instance belonging to a participant.
///
/// Spec: `data-model.md` §Participant And Device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: DeviceId,
    pub participant_id: ParticipantId,
    pub public_encryption_key: String,
    pub public_signing_key: String,
    pub client: DeviceClient,
    pub created_at: u64,
}

/// Device client kind. Maps to `attn-native`/`attn-browser`/`agent-cli` on the
/// wire so the relay can attribute traffic without a custom encoding.
///
/// Spec: `data-model.md` §Participant And Device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceClient {
    #[serde(rename = "attn-native")]
    AttnNative,
    #[serde(rename = "attn-browser")]
    AttnBrowser,
    #[serde(rename = "agent-cli")]
    AgentCli,
}

/// Capability strings granted to a participant inside a room.
///
/// Spec: `data-model.md` §Participant And Device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    RoomAdmin,
    ReadSnapshot,
    WriteComment,
    WriteSuggestion,
    ResolveComment,
    AcceptSuggestion,
    PublishSnapshot,
}

// ---------------------------------------------------------------------------
// Shared documents + local bindings
// ---------------------------------------------------------------------------

/// Review identity of a markdown file. Not necessarily a path on every
/// participant's machine.
///
/// Spec: `data-model.md` §Shared Document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDocument {
    pub file_id: FileId,
    pub owner_display_path: String,
    pub media_type: String,
    pub created_at: u64,
    pub latest_snapshot_id: SnapshotId,
}

/// Owner-private mapping from a `FileId` to its on-disk path. Never sent over
/// the wire.
///
/// Spec: `data-model.md` §Shared Document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileBinding {
    pub file_id: FileId,
    pub absolute_path: String,
    pub project_root: String,
}

// ---------------------------------------------------------------------------
// Snapshot graph
// ---------------------------------------------------------------------------

/// Immutable review base for a `FileId`.
///
/// Spec: `data-model.md` §Snapshot Graph. Per `amendments.md` decision #14,
/// `plaintext` is local-only; the wire form always uses `encryptedBlobRef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNode {
    pub snapshot_id: SnapshotId,
    pub file_id: FileId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_snapshot_id: Option<SnapshotId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_snapshot_id: Option<SnapshotId>,
    pub created_at: u64,
    pub created_by: ParticipantId,
    pub base_hash: ContentHash,
    pub byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_blob_ref: Option<BlobRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plaintext: Option<SnapshotPlaintext>,
}

/// Local-only decrypted snapshot payload (markdown + anchor index). Kept off
/// the wire per `amendments.md` decision #14.
///
/// Spec: `data-model.md` §Snapshot Graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPlaintext {
    pub markdown: String,
    pub anchor_index: AnchorIndex,
}

/// Reference to an encrypted blob — inline within an event, in the mailbox,
/// or in R2.
///
/// Spec: `data-model.md` §Snapshot Graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub storage: BlobStorage,
    pub blob_id: String,
    pub byte_length: u64,
    pub content_hash: ContentHash,
}

/// Where an encrypted blob lives.
///
/// Spec: `data-model.md` §Snapshot Graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlobStorage {
    Inline,
    Mailbox,
    R2,
}

// ---------------------------------------------------------------------------
// Local replicas + revision journal
// ---------------------------------------------------------------------------

/// Per-device local view of one shared document.
///
/// Spec: `data-model.md` §Local Replicas. (`Eq` is not derived because
/// `ReplicaRelation` carries `f64` confidence and `LocalRevision` carries
/// opaque `serde_json::Value` ProseMirror steps.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReplica {
    pub room_id: RoomId,
    pub participant_id: ParticipantId,
    pub device_id: DeviceId,
    pub file_id: FileId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_path: Option<String>,
    pub base_snapshot_id: SnapshotId,
    pub current_hash: ContentHash,
    pub current_markdown: String,
    pub current_index: AnchorIndex,
    pub relation_to_snapshot: ReplicaRelation,
    pub revision_journal: Vec<LocalRevision>,
}

/// Relationship between a `DocumentReplica.currentHash` and the
/// `baseSnapshotId`.
///
/// Spec: `data-model.md` §Local Replicas. Confidence is omitted for
/// `unknown` because nothing is known yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ReplicaRelation {
    Same {
        snapshot_id: SnapshotId,
        confidence: f64,
    },
    Changed {
        snapshot_id: SnapshotId,
        confidence: f64,
    },
    Unrelated {
        snapshot_id: SnapshotId,
        confidence: f64,
    },
    Unknown {
        snapshot_id: SnapshotId,
    },
}

/// One entry in the local revision journal. Persisted per file in
/// `revisions/<fileId>.jsonl` so a restart can resume sync.
///
/// Spec: `data-model.md` §Local Replicas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRevision {
    pub revision_id: String,
    pub parent_hash: ContentHash,
    pub next_hash: ContentHash,
    pub created_at: u64,
    pub source: RevisionSource,
    /// Opaque ProseMirror Step JSON values (one element per step in the
    /// transaction). Only populated for `prosemirror_edit` revisions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pm_steps: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_text: Option<String>,
}

/// Source that produced a `LocalRevision`.
///
/// Spec: `data-model.md` §Local Replicas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisionSource {
    SnapshotLoaded,
    ProsemirrorEdit,
    AcceptedSuggestion,
    ExternalFileChange,
    ManualReanchor,
}

// ---------------------------------------------------------------------------
// Anchor index
// ---------------------------------------------------------------------------

/// Snapshot-time index over a markdown document, used by the anchor resolver.
///
/// Spec: `data-model.md` §Anchor Index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorIndex {
    pub doc_hash: ContentHash,
    pub canonical_encoding: CanonicalEncoding,
    pub line_count: u32,
    pub blocks: Vec<AnchorBlock>,
    pub headings: Vec<AnchorHeading>,
}

/// Canonical encoding used for byte offsets. Fixed to `utf8-bytes` in v2.
///
/// Spec: `data-model.md` §Anchor Index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CanonicalEncoding {
    #[serde(rename = "utf8-bytes")]
    Utf8Bytes,
}

/// Block entry produced by the canonical anchor indexer.
///
/// Spec: `data-model.md` §Anchor Index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorBlock {
    pub snapshot_block_id: String,
    pub content_fingerprint: String,
    pub kind: AnchorBlockKind,
    pub byte_range: [u64; 2],
    pub line_range: [u32; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pm_range: Option<[u32; 2]>,
    pub heading_path: Vec<AnchorHeadingRef>,
    pub ordinal_in_parent: u32,
    pub duplicate_ordinal: u32,
    pub text_hash: String,
    pub normalized_text_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_block_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_block_hash: Option<String>,
}

/// Recognized block kinds. Includes `math` and `mermaid` per
/// `amendments.md` decision #16 (required for stable fingerprints inside
/// ProseMirror math/mermaid nodeviews). `unknown` is the safety fallback.
///
/// Spec: `data-model.md` §Anchor Index, `amendments.md` decision #16.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorBlockKind {
    Heading,
    Paragraph,
    ListItem,
    CodeBlock,
    Blockquote,
    Table,
    ThematicBreak,
    Html,
    Math,
    Mermaid,
    Unknown,
}

/// Heading entry produced by the canonical anchor indexer.
///
/// Spec: `data-model.md` §Anchor Index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorHeading {
    pub level: u32,
    pub text: String,
    pub text_hash: String,
    pub line: u32,
    pub byte_range: [u64; 2],
    pub path: Vec<AnchorHeadingRef>,
}

/// Reference to a heading at a specific level/ordinal for structural anchors.
///
/// Spec: `data-model.md` §Anchor Index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorHeadingRef {
    pub level: u32,
    pub text_hash: String,
    pub ordinal_at_level: u32,
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/// Layered anchor describing where a review event was authored.
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub v: u32,
    pub file_id: FileId,
    pub snapshot_id: SnapshotId,
    pub base_hash: ContentHash,
    pub position: PositionAnchor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<QuoteAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structure: Option<StructureAnchor>,
}

/// Snapshot-local byte/line/pm coordinates for an anchor.
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionAnchor {
    pub byte_range: [u64; 2],
    pub line_range: [u32; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pm_range: Option<[u32; 2]>,
}

/// Selected text with exact + normalized forms for quote-based remap.
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteAnchor {
    pub exact: String,
    pub exact_hash: String,
    pub normalized: String,
    pub normalized_hash: String,
}

/// Block-scoped anchor, used for block-level comments or in-block selections.
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAnchor {
    pub snapshot_block_id: String,
    pub content_fingerprint: String,
    pub kind: AnchorBlockKind,
    pub offset_in_block_bytes: [u64; 2],
    pub block_byte_range: [u64; 2],
    pub block_line_range: [u32; 2],
}

/// Surrounding context for an anchor (Hypothesis-style prefix/suffix).
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAnchor {
    pub prefix: String,
    pub suffix: String,
    pub prefix_hash: String,
    pub suffix_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_block_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_block_hash: Option<String>,
}

/// Heading-path structural anchor.
///
/// Spec: `data-model.md` §Anchors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureAnchor {
    pub heading_path: Vec<AnchorHeadingRef>,
    pub ordinal_in_parent: u32,
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

/// Outcome of resolving an `Anchor` against a `DocumentReplica`.
///
/// Spec: `data-model.md` §Anchor Resolution. Pinned algorithm in
/// `amendments.md` decision #15.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ResolvedAnchor {
    Exact {
        confidence: f64,
        current_range: PositionAnchor,
        reason: ExactReason,
    },
    Remapped {
        confidence: f64,
        current_range: PositionAnchor,
        reason: RemappedReason,
    },
    Ambiguous {
        candidates: Vec<ResolvedAnchorCandidate>,
        reason: String,
    },
    Stale {
        reason: String,
    },
}

/// Reason a resolution earned an `exact` status.
///
/// Spec: `data-model.md` §Anchor Resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExactReason {
    BaseHashMatch,
    MappedThroughLocalSteps,
}

/// Reason a resolution earned a `remapped` status (which fallback hit).
///
/// Spec: `data-model.md` §Anchor Resolution. The `Match` suffix is part of
/// the wire vocabulary in the spec — keep it even though variants share it.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemappedReason {
    QuoteMatch,
    BlockFingerprintMatch,
    StructureQuoteMatch,
    ContextMatch,
    FuzzyQuoteMatch,
}

/// One candidate range for an ambiguous anchor resolution.
///
/// Spec: `data-model.md` §Anchor Resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAnchorCandidate {
    pub confidence: f64,
    pub current_range: PositionAnchor,
    pub reason: String,
    pub preview: String,
}

// ---------------------------------------------------------------------------
// Review events
// ---------------------------------------------------------------------------

/// An append-only review-log entry. Idempotent by `meta.eventId`.
///
/// Spec: `data-model.md` §Review Events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewEvent {
    pub meta: EventMeta,
    pub body: ReviewEventBody,
    pub auth: EventAuth,
}

/// Authoring metadata shared by every review event.
///
/// Spec: `data-model.md` §Review Events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMeta {
    pub v: u32,
    pub event_id: EventId,
    pub room_id: RoomId,
    pub author_id: ParticipantId,
    pub device_id: DeviceId,
    pub created_at: u64,
    pub parent_event_ids: Vec<EventId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<SnapshotId>,
}

/// Cryptographic authentication trailer on every review event.
///
/// Spec: `data-model.md` §Review Events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAuth {
    pub signature: String,
    pub signing_key_id: String,
}

/// Discriminated union of every review-event body variant. Tagged by `type`
/// so a JSON stream can be parsed without a sidecar.
///
/// Spec: `data-model.md` §Review Events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ReviewEventBody {
    RoomCreated {
        room_id: RoomId,
        policy: RoomPolicy,
        created_by: ParticipantId,
    },
    ParticipantJoined {
        participant: Participant,
        device: Device,
    },
    SnapshotCreated {
        file_id: FileId,
        snapshot_id: SnapshotId,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_snapshot_id: Option<SnapshotId>,
        base_hash: ContentHash,
        #[serde(skip_serializing_if = "Option::is_none")]
        encrypted_blob_ref: Option<BlobRef>,
        /// Per `amendments.md` decision #14 this is always ciphertext on the
        /// wire; the field exists for round-trip compatibility with the spec
        /// shape and is populated only after local decrypt.
        #[serde(skip_serializing_if = "Option::is_none")]
        inline_snapshot: Option<SnapshotPlaintext>,
    },
    SnapshotSuperseded {
        file_id: FileId,
        old_snapshot_id: SnapshotId,
        new_snapshot_id: SnapshotId,
    },
    CommentCreated {
        thread_id: String,
        anchor: Anchor,
        body: String,
    },
    CommentResolved {
        thread_id: String,
        resolved_by: ParticipantId,
    },
    SuggestionCreated {
        suggestion_id: String,
        anchor: Anchor,
        operation: SuggestionOperation,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    SuggestionAccepted {
        suggestion_id: String,
        applied_revision_id: String,
        resulting_hash: ContentHash,
    },
    SuggestionRejected {
        suggestion_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    AnchorManuallyResolved {
        event_id: EventId,
        range: PositionAnchor,
        resolved_by: ParticipantId,
    },
    PresenceUpdated {
        participant_id: ParticipantId,
        device_id: DeviceId,
        online: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<PositionAnchor>,
    },
    SessionEnded {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// Conservative suggestion operation. Replace/delete carry `expectedText` so
/// apply can detect drift and trigger the three-way UI.
///
/// Spec: `data-model.md` §Suggestion Events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SuggestionOperation {
    Replace {
        expected_text: String,
        replacement: String,
    },
    InsertBefore {
        text: String,
    },
    InsertAfter {
        text: String,
    },
    Delete {
        expected_text: String,
    },
}

/// IPC payload describing a suggestion the frontend wants to create. Wraps
/// the anchor + operation + optional note so the manager can assemble a
/// `ReviewEventBody::SuggestionCreated` after minting a fresh suggestion id.
///
/// Spec: `data-model.md` §Webview IPC Changes (`review_create_suggestion`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionDraft {
    pub anchor: Anchor,
    pub operation: SuggestionOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// Mailbox envelopes
// ---------------------------------------------------------------------------

/// Server-routed encrypted envelope. The server stores and forwards these
/// blobs but never sees `ReviewEvent` plaintext.
///
/// Spec: `data-model.md` §Encrypted Envelopes; `relay-spec.md`
/// §`POST /v2/rooms/:roomId/envelopes` (`target` routing tag).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxEnvelope {
    pub v: u32,
    pub room_id: RoomId,
    pub envelope_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_seq: Option<u64>,
    pub author_id: ParticipantId,
    pub device_id: DeviceId,
    pub created_at: u64,
    pub expires_at: u64,
    pub kind: EnvelopeKind,
    /// Routing target for `kind: "signal"` envelopes. `Some` means deliver to
    /// the named device only; `None` means broadcast to every subscribed device
    /// in the room (or, for `kind: "event"` / `kind: "snapshot_blob"`, ignored
    /// by the relay — those kinds always broadcast). Per `relay-spec.md`
    /// §`POST /v2/rooms/:roomId/envelopes` the field is omitted (not `null`)
    /// when broadcasting, matching the canonical-JSON "omit absent optionals"
    /// rule in `crypto-spec.md` §Canonical JSON. Defaults to `None` on the
    /// receive path so existing payloads (and non-signal envelopes that never
    /// populate it) deserialize cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<EnvelopeTarget>,
    pub nonce: String,
    pub ciphertext: String,
    pub ciphertext_bytes: u64,
}

/// Routing tag carried on an envelope's cleartext header. Only `kind: "signal"`
/// envelopes set this — the relay uses it to forward straight to the named
/// device's open WebSocket (or store-and-forward if that device is offline).
///
/// Per `relay-spec.md` §Signaling, the relay never inspects the ciphertext;
/// the target is the *only* routing information it can use to direct signal
/// envelopes at a specific peer. The field is NOT bound into the AEAD AAD
/// (which would force the sender to know who they're addressing for every
/// retry); instead the signed signaling payload carries `from: deviceId`
/// and the receiver decides whether it is the intended recipient by the
/// content of the inner SDP/ICE/RequestSnapshot blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeTarget {
    pub device_id: DeviceId,
}

/// Kind of payload an envelope carries.
///
/// Spec: `data-model.md` §Encrypted Envelopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    Event,
    SnapshotBlob,
    Signal,
}

// ---------------------------------------------------------------------------
// Sync cursors + ACKs
// ---------------------------------------------------------------------------

/// Per-device sync cursor. Tracks what envelopes have been pulled and
/// what events have been imported.
///
/// Spec: `data-model.md` §Sync Cursors And ACKs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursor {
    pub room_id: RoomId,
    pub device_id: DeviceId,
    pub last_pulled_seq: u64,
    pub imported_event_ids: Vec<EventId>,
    pub pending_outbound_envelope_ids: Vec<String>,
}

/// Owner ACK of delivered envelopes/events. The relay may delete acked
/// envelopes when room policy allows it (`deleteEventsAfterOwnerAck`).
///
/// Spec: `data-model.md` §Sync Cursors And ACKs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAck {
    pub room_id: RoomId,
    pub device_id: DeviceId,
    pub acked_envelope_ids: Vec<String>,
    pub imported_event_ids: Vec<EventId>,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// Construct a typed newtype id from a string by going through serde.
    /// The newtypes in `ids.rs` are tuple structs with a private field, so
    /// outside callers can only mint them via deserialization (which matches
    /// the wire model — ids only enter the system through JSON).
    fn id<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(Value::String(s.to_string()))
            .expect("id deserializes from string")
    }

    /// Build a minimal valid `RoomPolicy` for tests.
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

    fn sample_meta(event_id: &str) -> EventMeta {
        EventMeta {
            v: 2,
            event_id: id::<EventId>(event_id),
            room_id: id::<RoomId>("room-abc"),
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_001,
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

    fn sample_anchor() -> Anchor {
        Anchor {
            v: 2,
            file_id: id::<FileId>("file-1"),
            snapshot_id: id::<SnapshotId>("snap-1"),
            base_hash: id::<ContentHash>("hash-1"),
            position: PositionAnchor {
                byte_range: [10, 20],
                line_range: [1, 1],
                pm_range: None,
            },
            quote: None,
            block: None,
            context: None,
            structure: None,
        }
    }

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn round_trip_room_created_event() {
        let event = ReviewEvent {
            meta: sample_meta("evt-1"),
            body: ReviewEventBody::RoomCreated {
                room_id: id::<RoomId>("room-abc"),
                policy: sample_policy(),
                created_by: id::<ParticipantId>("p-1"),
            },
            auth: sample_auth(),
        };

        let decoded: ReviewEvent = round_trip(&event);
        assert_eq!(event, decoded);

        // Confirm the body discriminator is keyed by `type`.
        let json = serde_json::to_value(&event).expect("to_value");
        assert_eq!(json["body"]["type"], json!("room_created"));
        assert_eq!(json["body"]["roomId"], json!("room-abc"));
        assert_eq!(json["body"]["createdBy"], json!("p-1"));
        assert_eq!(json["meta"]["eventId"], json!("evt-1"));
    }

    #[test]
    fn round_trip_suggestion_created_replace_event() {
        let event = ReviewEvent {
            meta: sample_meta("evt-2"),
            body: ReviewEventBody::SuggestionCreated {
                suggestion_id: "sug-1".to_string(),
                anchor: sample_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "foo".to_string(),
                    replacement: "bar".to_string(),
                },
                note: Some("typo".to_string()),
            },
            auth: sample_auth(),
        };

        let decoded: ReviewEvent = round_trip(&event);
        assert_eq!(event, decoded);

        let json = serde_json::to_value(&event).expect("to_value");
        assert_eq!(json["body"]["type"], json!("suggestion_created"));
        assert_eq!(json["body"]["suggestionId"], json!("sug-1"));
        assert_eq!(json["body"]["operation"]["kind"], json!("replace"));
        assert_eq!(json["body"]["operation"]["expectedText"], json!("foo"));
        assert_eq!(json["body"]["operation"]["replacement"], json!("bar"));
    }

    #[test]
    fn round_trip_mailbox_envelope() {
        let envelope = MailboxEnvelope {
            v: 2,
            room_id: id::<RoomId>("room-abc"),
            envelope_id: "env-1".to_string(),
            server_seq: Some(42),
            author_id: id::<ParticipantId>("p-1"),
            device_id: id::<DeviceId>("d-1"),
            created_at: 1_700_000_000_010,
            expires_at: 1_700_000_086_400,
            kind: EnvelopeKind::Event,
            target: None,
            nonce: "nonce-base64url".to_string(),
            ciphertext: "ct-base64url".to_string(),
            ciphertext_bytes: 128,
        };

        let decoded: MailboxEnvelope = round_trip(&envelope);
        assert_eq!(envelope, decoded);

        let json = serde_json::to_value(&envelope).expect("to_value");
        assert_eq!(json["kind"], json!("event"));
        assert_eq!(json["serverSeq"], json!(42));
        assert_eq!(json["ciphertextBytes"], json!(128));
    }

    #[test]
    fn anchor_block_kind_math_and_mermaid_serialize_snake_case() {
        // Decision #16: math and mermaid must be first-class kinds with
        // stable wire encoding so anchor fingerprints stay consistent across
        // ProseMirror nodeviews.
        let math = serde_json::to_value(AnchorBlockKind::Math).expect("math");
        let mermaid = serde_json::to_value(AnchorBlockKind::Mermaid).expect("mermaid");
        assert_eq!(math, json!("math"));
        assert_eq!(mermaid, json!("mermaid"));

        let math_back: AnchorBlockKind =
            serde_json::from_value(json!("math")).expect("math from_value");
        let mermaid_back: AnchorBlockKind =
            serde_json::from_value(json!("mermaid")).expect("mermaid from_value");
        assert_eq!(math_back, AnchorBlockKind::Math);
        assert_eq!(mermaid_back, AnchorBlockKind::Mermaid);
    }

    #[test]
    fn absent_optional_fields_are_omitted_not_null() {
        // EventMeta.snapshotId is Option<SnapshotId>; when None it must not
        // appear in JSON output at all (crypto-spec.md §Canonical JSON).
        let meta = sample_meta("evt-3");
        let json: Value = serde_json::to_value(&meta).expect("to_value");
        let obj = json.as_object().expect("object");
        assert!(
            !obj.contains_key("snapshotId"),
            "absent Option should be omitted, not serialized as null. Got: {json}"
        );

        // SnapshotNode has three optionals — none should appear when None.
        let node = SnapshotNode {
            snapshot_id: id::<SnapshotId>("snap-1"),
            file_id: id::<FileId>("file-1"),
            parent_snapshot_id: None,
            supersedes_snapshot_id: None,
            created_at: 1,
            created_by: id::<ParticipantId>("p-1"),
            base_hash: id::<ContentHash>("h"),
            byte_length: 0,
            encrypted_blob_ref: None,
            plaintext: None,
        };
        let json: Value = serde_json::to_value(&node).expect("to_value");
        let obj = json.as_object().expect("object");
        for key in [
            "parentSnapshotId",
            "supersedesSnapshotId",
            "encryptedBlobRef",
            "plaintext",
        ] {
            assert!(
                !obj.contains_key(key),
                "{key} should be omitted when None. Got: {json}"
            );
        }

        // Same expectation for an event body with optional fields.
        let body = ReviewEventBody::SuggestionRejected {
            suggestion_id: "sug-9".to_string(),
            reason: None,
        };
        let json: Value = serde_json::to_value(&body).expect("to_value");
        let obj = json.as_object().expect("object");
        assert!(!obj.contains_key("reason"));
    }
}
