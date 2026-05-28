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
let ipcToken: string | undefined = (
  window as unknown as { __attn_init__?: { ipcToken?: string } }
).__attn_init__?.ipcToken;

/** Capture the capability token before the init payload is cleared. */
export function setIpcToken(token: string | undefined): void {
  if (token) ipcToken = token;
}

function send(message: IpcMessage): void {
  if (window.ipc) {
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

export function editSave(content: string): void {
  send({ type: 'edit_save', content });
}

export function themeChange(theme: string): void {
  send({ type: 'theme_change', theme });
}

export function openExternal(path: string): void {
  send({ type: 'open_external', path });
}

export function openDevtools(): void {
  send({ type: 'open_devtools' });
}

/** Mousedown handler for drag regions — skips interactive child elements. */
export function dragWindow(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('a, button, input, select, textarea')) return;
  send({ type: 'drag_window' });
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
  mode: 'live' | 'async' | 'hybrid',
  ttl?: string,
): Promise<void> {
  send({ type: 'review_share', path, mode, ttl });
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
