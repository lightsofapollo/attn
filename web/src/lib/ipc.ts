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

function send(message: IpcMessage): void {
  if (window.ipc) {
    window.ipc.postMessage(JSON.stringify(message));
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
): Promise<void> {
  send({ type: 'review_create_comment', roomId, anchor, body });
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

export function reviewResolveAnchor(
  roomId: RoomId,
  eventId: EventId,
  range: PositionAnchor,
): Promise<void> {
  send({ type: 'review_resolve_anchor', roomId, eventId, range });
  return Promise.resolve();
}
