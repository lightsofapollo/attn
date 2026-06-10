export interface Progress {
  done: number;
  total: number;
}

export interface Phase {
  title: string;
  progress: Progress;
}

export interface Task {
  line: number;
  text: string;
  checked: boolean;
}

export interface PlanStructure {
  phases: Phase[];
  tasks: Task[];
  file_refs: string[];
}

export type FileType = 'markdown' | 'image' | 'video' | 'audio' | 'html' | 'directory' | 'unsupported';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  fileType: FileType;
}

export interface TreePatch {
  parentPath: string;
  children: TreeNode[];
}

export type TreeOp =
  | { op: 'remove'; path: string }
  | { op: 'upsert'; parentPath: string; node: TreeNode };

export interface SearchResultItem {
  path: string;
  fileType: FileType;
}

export interface SearchResultsPayload {
  query: string;
  items: SearchResultItem[];
}

/** @deprecated Use TreeNode instead */
export type FileEntry = TreeNode;

export interface ContentPayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  contentMtimeMs?: number;
  contentBytes?: number;
  treePatch?: TreePatch;
  treeOps?: TreeOp[];
  searchResults?: SearchResultsPayload;
}

export interface UpdatePayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath?: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  changedPaths?: string[];
  contentMtimeMs?: number;
  contentBytes?: number;
  treePatch?: TreePatch;
  treeOps?: TreeOp[];
  searchResults?: SearchResultsPayload;
}

export type IpcMessageType =
  | 'checkbox_toggle'
  | 'navigate'
  | 'switch_project'
  | 'load_children'
  | 'search_files'
  | 'edit_save'
  | 'theme_change'
  | 'open_external'
  | 'open_devtools'
  | 'drag_window'
  | 'js_log'
  | 'js_error'
  | 'review_share'
  | 'review_join'
  | 'review_create_comment'
  | 'review_create_suggestion'
  | 'review_accept_suggestion'
  | 'review_reject_suggestion'
  | 'review_resolve_anchor'
  | 'review_resolve_comment'
  | 'review_set_display_name'
  | 'review_stop'
  | 'review_collab_send';

export interface CheckboxToggleMessage {
  type: 'checkbox_toggle';
  line: number;
  checked: boolean;
}

export interface NavigateMessage {
  type: 'navigate';
  path: string;
}

export interface SwitchProjectMessage {
  type: 'switch_project';
  path: string;
}

export interface LoadChildrenMessage {
  type: 'load_children';
  path: string;
}

export interface SearchFilesMessage {
  type: 'search_files';
  query: string;
}

export interface EditSaveMessage {
  type: 'edit_save';
  content: string;
}

export interface ThemeChangeMessage {
  type: 'theme_change';
  theme: string;
}

export interface OpenExternalMessage {
  type: 'open_external';
  path: string;
}

export interface DragWindowMessage {
  type: 'drag_window';
}

export interface OpenDevtoolsMessage {
  type: 'open_devtools';
}

export interface JsLogMessage {
  type: 'js_log';
  level: string;
  message: string;
  source?: string;
  stack?: string;
}

export interface JsErrorMessage {
  type: 'js_error';
  message: string;
  source: string;
  line?: number;
  column?: number;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Review collaboration outbound IPC messages
//
// camelCase to match Rust's `#[serde(rename_all = "camelCase")]` on each
// review variant in `src/ipc.rs` (see attn-nnj.2.9). Payload field types come
// from the review domain types defined below.
// ---------------------------------------------------------------------------

export interface ReviewShareMessage {
  type: 'review_share';
  path: string;
  mode: 'live' | 'async' | 'hybrid';
  ttl?: string;
}

export interface ReviewJoinMessage {
  type: 'review_join';
  invite: string;
}

export interface ReviewCreateCommentMessage {
  type: 'review_create_comment';
  roomId: RoomId;
  anchor: Anchor;
  body: string;
}

export interface ReviewCreateSuggestionMessage {
  type: 'review_create_suggestion';
  roomId: RoomId;
  draft: SuggestionDraft;
}

export interface ReviewAcceptSuggestionMessage {
  type: 'review_accept_suggestion';
  roomId: RoomId;
  suggestionId: EventId;
  /**
   * Optional hand-edited replacement text. Set by the three-way apply UI's
   * `[e] edit` path (attn-nnj.8.3) when the owner hand-merges the snapshot's
   * proposed replacement with their own changes. When `undefined`, the Rust
   * resolver applies the suggestion's stored `replacement` verbatim.
   */
  editedReplacement?: string;
}

export interface ReviewRejectSuggestionMessage {
  type: 'review_reject_suggestion';
  roomId: RoomId;
  suggestionId: EventId;
  /** Optional free-text reason recorded on the SuggestionRejected event. */
  reason?: string;
}

export interface ReviewResolveAnchorMessage {
  type: 'review_resolve_anchor';
  roomId: RoomId;
  eventId: EventId;
  range: PositionAnchor;
}

export interface ReviewResolveCommentMessage {
  type: 'review_resolve_comment';
  roomId: RoomId;
  threadId: string;
}

export interface ReviewSetDisplayNameMessage {
  type: 'review_set_display_name';
  /** Empty/whitespace clears the override back to the resolved default. */
  name: string;
}

export interface ReviewStopMessage {
  type: 'review_stop';
  roomId?: RoomId;
}

export interface ReviewCollabSendMessage {
  type: 'review_collab_send';
  roomId: RoomId;
  /** Opaque prosemirror-collab JSON (submission or broadcast). */
  payload: string;
}

export type IpcMessage =
  | CheckboxToggleMessage
  | NavigateMessage
  | SwitchProjectMessage
  | LoadChildrenMessage
  | SearchFilesMessage
  | EditSaveMessage
  | ThemeChangeMessage
  | OpenExternalMessage
  | OpenDevtoolsMessage
  | DragWindowMessage
  | JsLogMessage
  | JsErrorMessage
  | ReviewShareMessage
  | ReviewJoinMessage
  | ReviewCreateCommentMessage
  | ReviewCreateSuggestionMessage
  | ReviewAcceptSuggestionMessage
  | ReviewRejectSuggestionMessage
  | ReviewResolveAnchorMessage
  | ReviewResolveCommentMessage
  | ReviewSetDisplayNameMessage
  | ReviewStopMessage
  | ReviewCollabSendMessage;

export type AppMode = 'read' | 'edit';

export type ThemeName = 'light' | 'dark';
export type DiagMode = 'full' | 'editor_only' | 'minimal';

export interface InitPayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath?: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  theme: ThemeName;
  diagMode?: DiagMode;
  /** The running attn version (CARGO_PKG_VERSION), for the update-available check. */
  version?: string;
  contentMtimeMs?: number;
  contentBytes?: number;
  reviewProfile?: ReviewProfileInit;
  /**
   * Per-session capability token. Injected only into the main app frame's
   * payload (never into an embedded HtmlViewer iframe). `ipc.send()` attaches
   * it to privileged messages; the daemon rejects privileged IPC without it,
   * so scripts in a sandboxed HTML file cannot drive the app. @see src/ipc.rs
   */
  ipcToken?: string;
}

/**
 * Onboarding display-name state seeded at startup. `displayName` is the user's
 * chosen name (null until set); `defaultDisplayName` is the resolved git/OS
 * default used to pre-fill the prompt; `displayNameSet` tells the UI whether to
 * prompt on first share/join.
 */
export interface ReviewProfileInit {
  displayName: string | null;
  defaultDisplayName: string;
  displayNameSet: boolean;
}

// ---------------------------------------------------------------------------
// Review domain types
//
// These mirror the Rust serde shapes (camelCase) defined in
// planning/collab/data-model.md and amended by planning/collab/amendments.md.
// They are pure type declarations — no runtime code, no `any`. Type aliases
// for ID newtypes are intentional: the Rust side uses tuple-struct newtypes
// that serde-serialize as bare strings.
// ---------------------------------------------------------------------------

/**
 * Opaque participant identifier.
 * @see planning/collab/data-model.md §Participant And Device
 */
export type ParticipantId = string;

/**
 * Opaque device identifier.
 * @see planning/collab/data-model.md §Participant And Device
 */
export type DeviceId = string;

/**
 * Opaque room identifier.
 * @see planning/collab/data-model.md §Review Room
 */
export type RoomId = string;

/**
 * Opaque shared-document identifier (not a path).
 * @see planning/collab/data-model.md §Shared Document
 */
export type FileId = string;

/**
 * Opaque snapshot identifier.
 * @see planning/collab/data-model.md §Snapshot Graph
 */
export type SnapshotId = string;

/**
 * Opaque event identifier.
 * @see planning/collab/data-model.md §Review Events
 */
export type EventId = string;

/**
 * Canonical content hash of UTF-8 markdown bytes.
 * @see planning/collab/data-model.md §Snapshot Graph
 */
export type ContentHash = string;

/**
 * Capability strings granted to a participant inside a room.
 * @see planning/collab/data-model.md §Participant And Device
 */
export type Capability =
  | 'room_admin'
  | 'read_snapshot'
  | 'write_comment'
  | 'write_suggestion'
  | 'resolve_comment'
  | 'accept_suggestion'
  | 'publish_snapshot';

/**
 * Person or agent participating in a review room.
 * @see planning/collab/data-model.md §Participant And Device
 */
export interface Participant {
  participantId: ParticipantId;
  displayName: string;
  kind: 'owner' | 'reviewer' | 'agent';
  publicSigningKey: string;
  capabilities: Capability[];
}

/**
 * One installed client instance belonging to a participant.
 * @see planning/collab/data-model.md §Participant And Device
 */
export interface Device {
  deviceId: DeviceId;
  participantId: ParticipantId;
  publicEncryptionKey: string;
  publicSigningKey: string;
  client: 'attn-native' | 'attn-browser' | 'agent-cli';
  createdAt: number;
}

/**
 * Room-level capability and lifecycle policy enforced by the relay.
 * @see planning/collab/data-model.md §Review Room
 */
export interface RoomPolicy {
  mode: 'live' | 'async' | 'hybrid';
  maxPeers: number;
  maxSnapshotBytes: number;
  maxEventBytes: number;
  maxEvents: number;
  expiresAt: number;
  deleteEventsAfterOwnerAck: boolean;
  allowBrowser: boolean;
  allowRemoteAgents: boolean;
}

/**
 * Reference to an encrypted blob stored inline, in the mailbox, or on R2.
 * @see planning/collab/data-model.md §Snapshot Graph
 */
export interface BlobRef {
  storage: 'inline' | 'mailbox' | 'r2';
  blobId: string;
  byteLength: number;
  contentHash: ContentHash;
}

/**
 * Reference to a heading at a specific level/ordinal for structural anchors.
 * @see planning/collab/data-model.md §Anchor Index
 */
export interface AnchorHeadingRef {
  level: number;
  textHash: string;
  ordinalAtLevel: number;
}

/**
 * Heading entry produced by the canonical anchor indexer.
 * @see planning/collab/data-model.md §Anchor Index
 */
export interface AnchorHeading {
  level: number;
  text: string;
  textHash: string;
  line: number;
  byteRange: [number, number];
  path: AnchorHeadingRef[];
}

/**
 * Kinds of block recognized by the anchor index.
 *
 * The original eight variants from data-model.md plus `math` and `mermaid`
 * per amendments.md Decision #16, plus `unknown` as a safety fallback.
 * @see planning/collab/data-model.md §Anchor Index
 * @see planning/collab/amendments.md Decision #16
 */
export type AnchorBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'code_block'
  | 'blockquote'
  | 'table'
  | 'thematic_break'
  | 'html'
  | 'math'
  | 'mermaid'
  | 'unknown';

/**
 * Block entry produced by the canonical anchor indexer.
 * @see planning/collab/data-model.md §Anchor Index
 */
export interface AnchorBlock {
  snapshotBlockId: string;
  contentFingerprint: string;
  kind: AnchorBlockKind;
  byteRange: [number, number];
  lineRange: [number, number];
  pmRange?: [number, number];
  headingPath: AnchorHeadingRef[];
  ordinalInParent: number;
  duplicateOrdinal: number;
  textHash: string;
  normalizedTextHash: string;
  previousBlockHash?: string;
  nextBlockHash?: string;
}

/**
 * Snapshot-time index over a markdown document, used by the anchor resolver.
 * @see planning/collab/data-model.md §Anchor Index
 */
export interface AnchorIndex {
  docHash: ContentHash;
  canonicalEncoding: 'utf8-bytes';
  lineCount: number;
  blocks: AnchorBlock[];
  headings: AnchorHeading[];
}

/**
 * Snapshot-local byte/line/pm coordinates for an anchor.
 * @see planning/collab/data-model.md §Anchors
 */
export interface PositionAnchor {
  byteRange: [number, number];
  lineRange: [number, number];
  pmRange?: [number, number];
}

/**
 * Selected text with exact + normalized forms for quote-based remap.
 * @see planning/collab/data-model.md §Anchors
 */
export interface QuoteAnchor {
  exact: string;
  exactHash: string;
  normalized: string;
  normalizedHash: string;
}

/**
 * Block-scoped anchor, used for block-level comments or in-block selections.
 * @see planning/collab/data-model.md §Anchors
 */
export interface BlockAnchor {
  snapshotBlockId: string;
  contentFingerprint: string;
  kind: AnchorBlockKind;
  offsetInBlockBytes: [number, number];
  blockByteRange: [number, number];
  blockLineRange: [number, number];
}

/**
 * Surrounding context for an anchor (Hypothesis-style prefix/suffix).
 * @see planning/collab/data-model.md §Anchors
 */
export interface ContextAnchor {
  prefix: string;
  suffix: string;
  prefixHash: string;
  suffixHash: string;
  previousBlockHash?: string;
  nextBlockHash?: string;
}

/**
 * Heading-path structural anchor.
 * @see planning/collab/data-model.md §Anchors
 */
export interface StructureAnchor {
  headingPath: AnchorHeadingRef[];
  ordinalInParent: number;
}

/**
 * Layered anchor describing where a review event was authored.
 *
 * The resolver uses the strongest available layer and falls back with
 * decreasing confidence.
 * @see planning/collab/data-model.md §Anchors
 */
export interface Anchor {
  v: 2;
  fileId: FileId;
  snapshotId: SnapshotId;
  baseHash: ContentHash;
  position: PositionAnchor;
  quote?: QuoteAnchor;
  block?: BlockAnchor;
  context?: ContextAnchor;
  structure?: StructureAnchor;
}

/**
 * Single ranked candidate for an ambiguous anchor resolution.
 * @see planning/collab/data-model.md §Anchor Resolution
 */
export interface ResolvedAnchorCandidate {
  confidence: number;
  currentRange: PositionAnchor;
  reason: string;
  preview: string;
}

/**
 * Outcome of resolving an `Anchor` against a `DocumentReplica`.
 * @see planning/collab/data-model.md §Anchor Resolution
 */
export type ResolvedAnchor =
  | {
      status: 'exact';
      confidence: 1.0;
      currentRange: PositionAnchor;
      reason: 'base_hash_match' | 'mapped_through_local_steps';
    }
  | {
      status: 'remapped';
      confidence: number;
      currentRange: PositionAnchor;
      reason:
        | 'quote_match'
        | 'block_fingerprint_match'
        | 'structure_quote_match'
        | 'context_match'
        | 'fuzzy_quote_match';
    }
  | {
      status: 'ambiguous';
      candidates: ResolvedAnchorCandidate[];
      reason: string;
    }
  | {
      status: 'stale';
      reason: string;
    };

/**
 * Conservative suggestion operation. Replace/delete carry `expectedText` so
 * apply can detect drift and trigger the three-way UI.
 * @see planning/collab/data-model.md §Suggestion Events
 */
export type SuggestionOperation =
  | {
      kind: 'replace';
      expectedText: string;
      replacement: string;
    }
  | {
      kind: 'insert_before';
      text: string;
    }
  | {
      kind: 'insert_after';
      text: string;
    }
  | {
      kind: 'delete';
      expectedText: string;
    };

/**
 * Draft payload sent over IPC by the frontend when creating a suggestion.
 *
 * Wraps the anchor + operation (+ optional note) so the Rust ReviewManager
 * can mint a fresh `suggestionId` and assemble a `SuggestionCreatedBody`.
 * Mirrors `crate::review::model::SuggestionDraft` (camelCase serde).
 * @see planning/collab/data-model.md §Webview IPC Changes
 */
export interface SuggestionDraft {
  anchor: Anchor;
  operation: SuggestionOperation;
  note?: string;
}

/**
 * Authoring metadata shared by every review event.
 * @see planning/collab/data-model.md §Review Events
 */
export interface EventMeta {
  v: 2;
  eventId: EventId;
  roomId: RoomId;
  authorId: ParticipantId;
  deviceId: DeviceId;
  createdAt: number;
  parentEventIds: EventId[];
  snapshotId?: SnapshotId;
}

/**
 * Cryptographic authentication trailer on every review event.
 * @see planning/collab/data-model.md §Review Events
 */
export interface EventAuth {
  signature: string;
  signingKeyId: string;
}

/**
 * Initial room-creation event. Emitted once per room by the owner.
 * @see planning/collab/data-model.md §Review Events
 */
export interface RoomCreatedBody {
  type: 'room_created';
  roomId: RoomId;
  policy: RoomPolicy;
  createdBy: ParticipantId;
}

/**
 * A participant has joined the room.
 * @see planning/collab/data-model.md §Review Events
 */
export interface ParticipantJoinedBody {
  type: 'participant_joined';
  participant: Participant;
  device: Device;
}

/**
 * Owner published a new snapshot for a shared document.
 * @see planning/collab/data-model.md §Snapshot Events
 */
export interface SnapshotCreatedBody {
  type: 'snapshot_created';
  fileId: FileId;
  snapshotId: SnapshotId;
  ownerDisplayPath?: string;
  parentSnapshotId?: SnapshotId;
  baseHash: ContentHash;
  encryptedBlobRef?: BlobRef;
  inlineSnapshot?: {
    markdown: string;
    anchorIndex: AnchorIndex;
  };
}

/**
 * A snapshot was superseded by a newer one in the graph.
 * @see planning/collab/data-model.md §Snapshot Events
 */
export interface SnapshotSupersededBody {
  type: 'snapshot_superseded';
  fileId: FileId;
  oldSnapshotId: SnapshotId;
  newSnapshotId: SnapshotId;
}

/**
 * Reviewer or owner created a comment anchored to a snapshot range.
 * @see planning/collab/data-model.md §Comment Events
 */
export interface CommentCreatedBody {
  type: 'comment_created';
  threadId: string;
  anchor: Anchor;
  body: string;
}

/**
 * A comment thread has been resolved.
 * @see planning/collab/data-model.md §Comment Events
 */
export interface CommentResolvedBody {
  type: 'comment_resolved';
  threadId: string;
  resolvedBy: ParticipantId;
}

/**
 * Reviewer proposed an edit. Includes `expectedText` for apply-time safety.
 * @see planning/collab/data-model.md §Suggestion Events
 */
export interface SuggestionCreatedBody {
  type: 'suggestion_created';
  suggestionId: string;
  anchor: Anchor;
  operation: SuggestionOperation;
  note?: string;
}

/**
 * Owner accepted a suggestion. Emitted after the local working copy write.
 * @see planning/collab/data-model.md §Suggestion Events
 */
export interface SuggestionAcceptedBody {
  type: 'suggestion_accepted';
  suggestionId: string;
  appliedRevisionId: string;
  resultingHash: ContentHash;
}

/**
 * Owner rejected a suggestion.
 * @see planning/collab/data-model.md §Suggestion Events
 */
export interface SuggestionRejectedBody {
  type: 'suggestion_rejected';
  suggestionId: string;
  reason?: string;
}

/**
 * Owner manually resolved an ambiguous/stale anchor to a current range.
 * @see planning/collab/data-model.md §Review Events
 */
export interface AnchorManuallyResolvedBody {
  type: 'anchor_manually_resolved';
  eventId: EventId;
  range: PositionAnchor;
  resolvedBy: ParticipantId;
}

/**
 * Live-presence heartbeat for the peer strip.
 * @see planning/collab/data-model.md §Review Events
 */
export interface PresenceUpdatedBody {
  type: 'presence_updated';
  participantId: ParticipantId;
  deviceId: DeviceId;
  online: boolean;
  cursor?: PositionAnchor;
}

/**
 * Live session ended (used to clear presence + close peer strip).
 * @see planning/collab/data-model.md §Review Events
 */
export interface SessionEndedBody {
  type: 'session_ended';
  reason?: string;
}

/**
 * Discriminated union of every review-event body variant.
 * @see planning/collab/data-model.md §Review Events
 */
export type ReviewEventBody =
  | RoomCreatedBody
  | ParticipantJoinedBody
  | SnapshotCreatedBody
  | SnapshotSupersededBody
  | CommentCreatedBody
  | CommentResolvedBody
  | SuggestionCreatedBody
  | SuggestionAcceptedBody
  | SuggestionRejectedBody
  | AnchorManuallyResolvedBody
  | PresenceUpdatedBody
  | SessionEndedBody;

/**
 * An append-only review-log entry. Idempotent by `meta.eventId`, signed by
 * `auth.signingKeyId`.
 * @see planning/collab/data-model.md §Review Events
 */
export interface ReviewEvent {
  meta: EventMeta;
  body: ReviewEventBody;
  auth: EventAuth;
}

/**
 * Pushed via `window.__attn__.reviewShareReady(...)` immediately after
 * the daemon mints (or re-emits) an invite. Carries everything the
 * Share dialog needs to render the URL + fingerprint without a second
 * round-trip.
 *
 * Wire shape mirrors `ReviewUpdate::ShareReady` in `src/review/manager.rs`.
 */
export interface ReviewShareReady {
  kind: 'share_ready';
  roomId: RoomId;
  inviteUrl: string;
  /** Absolute path the owner shared (file or folder); the dialog matches it
   *  against the active target to recognise its own room. */
  ownerDisplayPath: string;
  /** Base64url Ed25519 public signing key; fingerprint is sha256(this). */
  ownerSigningKey: string;
  mode: 'live' | 'async' | 'hybrid';
  expiresAt: number;
  newlyCreated: boolean;
}

/**
 * Review command failure surfaced through `window.__attn__.reviewStatus(...)`
 * until the bridge grows a dedicated error callback.
 */
export interface ReviewErrorStatus {
  kind: 'error';
  roomId?: RoomId | null;
  code: string;
  message: string;
}

/**
 * Transport/connection status surfaced to the UI for one room.
 *
 * Pushed via `window.__attn__.reviewStatus(...)` from Rust (see
 * `planning/collab/data-model.md` §Webview IPC Changes).
 */
export interface ReviewStatus {
  kind?: string;
  roomId: RoomId;
  status?: string;
  mode: RoomPolicy['mode'];
  connection: 'live_direct' | 'mailbox' | 'offline' | 'direct_failed';
  peers: ReviewStatusPeer[];
  outboxPending: number;
  pendingCount?: number;
  lastImportedSeq?: number;
  expiresAt?: number;
}

/**
 * Per-peer presence summary used inside `ReviewStatus.peers`.
 */
export interface ReviewStatusPeer {
  participantId: ParticipantId;
  deviceId: DeviceId;
  displayName: string;
  kind: Participant['kind'];
  online: boolean;
  onSnapshotId?: SnapshotId;
  locationFileId?: FileId;
  locationSnapshotId?: SnapshotId;
  locationPath?: string;
  lastLocationAt?: number;
}

/**
 * Live presence delta pushed via `window.__attn__.reviewPresence(...)`.
 *
 * The daemon translates relay `hello`/`presence` frames into this shape.
 * `replace=true` carries the authoritative full roster (a Hello frame on
 * (re)connect); `replace=false` is a single join/leave the store merges by
 * `deviceId`. @see store.applyPresence.
 */
export interface ReviewPresenceChanged {
  roomId: RoomId;
  peers: ReviewStatusPeer[];
  replace: boolean;
}

/**
 * Live transport connection-state change pushed via
 * `window.__attn__.reviewConnection(...)`. The daemon emits `mailbox` when
 * the relay socket subscribes and `offline` on disconnect. Drives the
 * ConnectionBadge. @see store.applyConnection.
 */
export interface ReviewConnectionChanged {
  roomId: RoomId;
  connection: ReviewStatus['connection'];
}

/**
 * Inbound live co-typing traffic pushed via
 * `window.__attn__.reviewCollab(...)`. `payload` is the opaque
 * prosemirror-collab JSON (a CollabSubmission or CollabBroadcast, JSON-
 * stringified) the sender's webview emitted; `from` is the originating device
 * so the receiver can drop its own echoes. @see prosemirror/collab-session.
 */
export interface ReviewCollabSignal {
  roomId: RoomId;
  from: DeviceId;
  payload: string;
}

/**
 * Snapshot payload pushed via `window.__attn__.reviewSnapshot(...)` when Rust
 * imports a new snapshot (live DataChannel or mailbox).
 * @see planning/collab/data-model.md §Snapshot Graph
 */
export interface ReviewSnapshot {
  roomId: RoomId;
  fileId: FileId;
  snapshotId: SnapshotId;
  ownerDisplayPath?: string;
  parentSnapshotId?: SnapshotId;
  supersedesSnapshotId?: SnapshotId;
  createdAt: number;
  createdBy: ParticipantId;
  baseHash: ContentHash;
  byteLength: number;
  markdown?: string;
  anchorIndex?: AnchorIndex;
  encryptedBlobRef?: BlobRef;
}

/**
 * Per-event anchor-resolution update pushed via
 * `window.__attn__.reviewAnchorResolution(...)` whenever the local replica
 * changes (edit, snapshot import, manual reanchor).
 * @see planning/collab/data-model.md §Anchor Resolution
 */
export interface ReviewAnchorResolutionUpdate {
  roomId: RoomId;
  fileId: FileId;
  eventId: EventId;
  resolved: ResolvedAnchor;
}

/**
 * A reconstructed comment thread: a root `CommentCreated` event plus any
 * replies (other `CommentCreated` events in the same `threadId`) and a
 * resolved flag flipped by a matching `CommentResolved` event.
 *
 * Threads are derived from the append-only review-event log by the selectors
 * in `web/src/lib/review/selectors.ts`. The root is the earliest comment in
 * the thread (by `meta.createdAt`); replies are ordered the same way. The
 * thread's `anchor` is taken from the root event so the panel/margin card
 * can position itself, and `resolvedAnchor` is the latest anchor-resolution
 * verdict (exact / remapped / ambiguous / stale) for that root event.
 * @see planning/collab/data-model.md §Comment Events
 */
export interface Thread {
  /** Thread id from `CommentCreatedBody.threadId`. */
  id: string;
  /** Earliest `CommentCreated` event sharing this `threadId`. */
  rootEvent: ReviewEvent;
  /** Later `CommentCreated` events in the same thread, ordered by createdAt. */
  replies: ReviewEvent[];
  /** Flipped to `true` by a `CommentResolved` event for this thread. */
  resolved: boolean;
  /** Anchor authored on the root comment (null only for malformed input). */
  anchor: Anchor | null;
  /** Latest resolver verdict against `rootEvent.meta.eventId`, if any. */
  resolvedAnchor: ResolvedAnchor | null;
}

// ---------------------------------------------------------------------------
// Apply verdict (mirrors `crate::review::apply::ApplyVerdict`)
//
// Produced by the Rust resolver when the owner clicks `[accept]` on a
// suggestion card. The frontend only needs the `RequiresThreeWay` shape to
// drive `ReviewApplyExpand.svelte` (attn-nnj.8.3); other variants are routed
// elsewhere (Ready writes silently, Ambiguous → orphan tray, Stale → re-anchor
// flow). See `src/review/apply.rs:174` for the canonical Rust definition.
// ---------------------------------------------------------------------------

/**
 * How the snapshot's `expected_text` compared to what is currently at the
 * target byte range, for the `Ready` verdict.
 * @see src/review/apply.rs `TextMatchKind`
 */
export type TextMatchKind =
  | 'exact'
  | 'normalized_unicode'
  | 'trailing_whitespace'
  | 'mismatch';

/**
 * `Ready` verdict — the suggestion can apply silently. Frontend writes
 * `replacement` at `targetByteRange`.
 * @see src/review/apply.rs `ApplyVerdict::Ready`
 */
export interface ReadyVerdict {
  kind: 'ready';
  suggestionId: EventId;
  targetByteRange: [number, number];
  replacement: string;
  confidence: number;
  matchKind: TextMatchKind;
  confidenceNote?: string;
}

/**
 * `RequiresThreeWay` verdict — drift between snapshot's `expectedText` and
 * current bytes. Drives `ReviewApplyExpand.svelte`.
 * @see src/review/apply.rs `ApplyVerdict::RequiresThreeWay`
 */
export interface RequiresThreeWayVerdict {
  kind: 'requires_three_way';
  suggestionId: EventId;
  roomId: RoomId;
  targetByteRange: [number, number];
  /** Text the suggestion expected to find when it was authored. */
  snapshotExpected: string;
  /** Text actually present at the target range right now. */
  currentText: string;
  /** Text the suggestion would write if accepted. */
  proposedReplacement: string;
  confidence: number;
  /** Reviewer display name (optional — falls back to participant id). */
  reviewerDisplayName?: string;
  /** Reviewer event creation time (ms since epoch). */
  createdAt?: number;
}

/**
 * `Ambiguous` verdict — multiple candidate positions; user picks one.
 * Routed to the orphan-tray candidate picker.
 * @see src/review/apply.rs `ApplyVerdict::Ambiguous`
 */
export interface AmbiguousVerdict {
  kind: 'ambiguous';
  suggestionId: EventId;
  candidates: ResolvedAnchorCandidate[];
}

/**
 * `Stale` verdict — anchor cannot resolve; manual re-anchor required.
 * @see src/review/apply.rs `ApplyVerdict::Stale`
 */
export interface StaleVerdict {
  kind: 'stale';
  suggestionId: EventId;
  reason: string;
}

/**
 * Discriminated union of every apply-verdict variant.
 * @see src/review/apply.rs `ApplyVerdict`
 */
export type ApplyVerdict =
  | ReadyVerdict
  | RequiresThreeWayVerdict
  | AmbiguousVerdict
  | StaleVerdict;
