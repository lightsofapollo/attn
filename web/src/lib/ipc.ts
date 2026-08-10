import type {
  Anchor,
  EventId,
  IpcMessage,
  PositionAnchor,
  RoomId,
  SuggestionDraft,
} from './types';

interface WryIpc {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    ipc?: WryIpc;
  }
}

// Per-session capability token, injected only into the main app frame's init
// payload. The daemon requires it on privileged messages, so scripts inside a
// sandboxed HtmlViewer iframe — which never receives the token — cannot drive
// the app. @see src/ipc.rs handle_message.
//
// Captured at module load AND settable via `setIpcToken`: App.svelte deletes
// `window.__attn_init__` after reading it once, so we cannot rely on reading it
// lazily inside `send()`. The setter makes this robust regardless of whether
// this module evaluates before or after that delete.
// Guard the `window` read with `typeof` — this runs at module load, and the
// module is imported in the Node test environment where `window` is undefined.
let ipcToken: string | undefined =
  typeof window !== 'undefined'
    ? (window as unknown as { __attn_init__?: { ipcToken?: string } }).__attn_init__?.ipcToken
    : undefined;

/** Capture the capability token before the init payload is cleared. */
export function setIpcToken(token: string | undefined): void {
  if (token) ipcToken = token;
}

/**
 * Outbound messages whose Rust `IpcMessage` variant exists but which have no
 * mirror in `types.ts` yet. `rail_width_change` (attn-11g4.2) belongs in the
 * `IpcMessage` union there; it lives here until that file is next touched, so
 * the wire shape is still checked rather than cast away at the call site.
 */
type PendingIpcMessage = { type: 'rail_width_change'; width: number };

function send(message: IpcMessage | PendingIpcMessage): void {
  if (typeof window !== 'undefined' && window.ipc) {
    const payload = ipcToken ? { ...message, token: ipcToken } : message;
    window.ipc.postMessage(JSON.stringify(payload));
  }
}

export function checkboxToggle(line: number, checked: boolean): void {
  send({ type: 'checkbox_toggle', line, checked });
}

export function navigate(path: string): void {
  send({ type: 'navigate', path });
}

export function switchProject(path: string): void {
  send({ type: 'switch_project', path });
}

export function loadChildren(path: string): void {
  send({ type: 'load_children', path });
}

export function searchFiles(query: string): void {
  send({ type: 'search_files', query });
}

export function reviewListShareableFiles(rootPath: string): void {
  send({ type: 'review_list_shareable_files', rootPath });
}

export function editSave(content: string): void {
  send({ type: 'edit_save', content });
}

export function themeChange(theme: string): void {
  send({ type: 'theme_change', theme });
}

export function typesetChange(typeset: string): void {
  send({ type: 'typeset_change', typeset });
}

/**
 * Persist the expanded review rail's width (attn-11g4.2).
 *
 * Sent on drag end / reset / after a keyboard nudge settles, not on every
 * pointermove — this writes prefs.json, and a drag is hundreds of frames.
 * The daemon re-clamps via `prefs::normalize_rail_width`; the rounding here is
 * for the log line and the JSON, not a trust boundary.
 *
 * No-ops without `window.ipc`, which is exactly the hosted browser build: the
 * rail still resizes for the session, it just forgets — same degradation as
 * `themeChange`/`typesetChange`.
 */
export function railWidthChange(width: number): void {
  send({ type: 'rail_width_change', width: Math.round(width) });
}

export function openExternal(path: string): void {
  send({ type: 'open_external', path });
}

export function openDevtools(): void {
  send({ type: 'open_devtools' });
}

export function setResidentLaunchAtLogin(enabled: boolean): void {
  send({ type: 'resident_launch_at_login', enabled });
}

/** Mousedown handler for drag regions — skips interactive child elements. */
export function dragWindow(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('a, button, input, select, textarea')) return;
  send({ type: 'drag_window' });
}

/** Double-click handler for drag regions — native titlebar zoom/restore,
 *  with the same interactive-element exclusion as dragWindow. */
export function zoomWindow(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('a, button, input, select, textarea')) return;
  send({ type: 'zoom_window' });
}

// ---------------------------------------------------------------------------
// Review collaboration outbound commands
//
// Each function builds a payload that matches the Rust `IpcMessage` variant
// declared in `src/ipc.rs` (issue attn-nnj.2.9). The Rust side uses
// `#[serde(tag = "type", rename_all = "snake_case")]` on the enum and
// `rename_all = "camelCase"` on each variant — so the wire shape here is
// `{ type: "review_*", camelCaseField: ... }`.
//
// Return type is `Promise<void>` for now: the Rust handlers in 2.9 are
// `eprintln!` stubs and no response is wired back through the webview IPC
// boundary. Real return-value wiring (snapshot ids, accept results) will be
// added when `ReviewManager` lands in attn-nnj.2.8.
// ---------------------------------------------------------------------------

export function reviewShare(
  path: string,
  selectedPaths: string[],
  primaryPath: string,
  mode: 'live' | 'async' | 'hybrid',
  ttl?: string,
): Promise<void> {
  send({ type: 'review_share', path, selectedPaths, primaryPath, mode, ttl });
  return Promise.resolve();
}

export function reviewJoin(invite: string): Promise<void> {
  send({ type: 'review_join', invite });
  return Promise.resolve();
}

export function reviewCreateComment(
  roomId: RoomId,
  anchor: Anchor,
  body: string,
  parentThreadId?: string,
): Promise<void> {
  // `parentThreadId` joins an existing thread as a reply (attn-1rm); omit it to
  // open a new thread. The reply reuses the root comment's anchor.
  send({
    type: 'review_create_comment',
    roomId,
    anchor,
    body,
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
  });
  return Promise.resolve();
}

export function reviewCreateSuggestion(
  roomId: RoomId,
  draft: SuggestionDraft,
): Promise<void> {
  send({ type: 'review_create_suggestion', roomId, draft });
  return Promise.resolve();
}

export function reviewAcceptSuggestion(
  roomId: RoomId,
  suggestionId: EventId,
  editedReplacement?: string,
): Promise<void> {
  send({
    type: 'review_accept_suggestion',
    roomId,
    suggestionId,
    ...(editedReplacement !== undefined ? { editedReplacement } : {}),
  });
  return Promise.resolve();
}

export function reviewRejectSuggestion(
  roomId: RoomId,
  suggestionId: EventId,
  reason?: string,
): Promise<void> {
  send({
    type: 'review_reject_suggestion',
    roomId,
    suggestionId,
    ...(reason !== undefined ? { reason } : {}),
  });
  return Promise.resolve();
}

export function reviewResolveAnchor(
  roomId: RoomId,
  eventId: EventId,
  range: PositionAnchor,
): Promise<void> {
  send({ type: 'review_resolve_anchor', roomId, eventId, range });
  return Promise.resolve();
}

/**
 * Mark a comment thread resolved. The daemon mints a `CommentResolved` event
 * that propagates to peers; `reconstructThreads` flips the thread's `resolved`
 * flag off it, collapsing the card to its resolved strip.
 */
export function reviewResolveComment(roomId: RoomId, threadId: string): Promise<void> {
  send({ type: 'review_resolve_comment', roomId, threadId });
  return Promise.resolve();
}

/**
 * Persist the user's chosen display name (onboarding). Written to the device
 * identity; the next Share/Join publishes it as the participant's display name.
 * Empty/whitespace clears the override back to the resolved git/OS default.
 */
export function reviewSetDisplayName(name: string): Promise<void> {
  send({ type: 'review_set_display_name', name });
  return Promise.resolve();
}

/** Persist the picked identity color (attn-3gdd) onto the device identity.
 * Empty string clears back to the automatic hash color. */
export function reviewSetColor(color: string): Promise<void> {
  send({ type: 'review_set_color', color });
  return Promise.resolve();
}

export function reviewStop(roomId?: RoomId): Promise<void> {
  send({ type: 'review_stop', ...(roomId !== undefined ? { roomId } : {}) });
  return Promise.resolve();
}

/**
 * Send a live co-typing payload (a stringified CollabSubmission or
 * CollabBroadcast) to the room over the encrypted signal channel. The daemon
 * shuttles `payload` opaquely.
 */
export function reviewCollabSend(roomId: RoomId, payload: string): void {
  send({ type: 'review_collab_send', roomId, payload });
}

/** Report the native read-marker predicates. Rust clears only when both true. */
export function reviewViewState(
  roomId: RoomId,
  roomVisible: boolean,
  windowFocused: boolean,
): void {
  send({ type: 'review_view_state', roomId, roomVisible, windowFocused });
}

/** Persist the per-room native OS notification preference. */
export function reviewNotificationMute(roomId: RoomId, muted: boolean): void {
  send({ type: 'review_notification_mute', roomId, muted });
}
