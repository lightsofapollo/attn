# Browser room ownership and sharing

Depends on: Phase 02

## Purpose

Let a browser-local workspace become the owner/source of an existing attn
review room. Reuse the exact native room, event, snapshot, E2EE, mailbox, and
WebRTC protocol rather than creating a web-only sharing system.

## Implementation steps

### Step 1 — Implement browser owner bootstrap

Add canonical room create/rejoin request signing, owner device registration,
`RoomCreated`, owner `ParticipantJoined`, room-policy validation, and rollback
using the current relay protocol and Rust interoperability vectors.

### Step 2 — Persist room ownership and invite capability

Atomically bind workspace share records to the room, encrypted owner identity,
wrapped raw invite capability, current published revision, and transport state.
Interrupted sharing must either resume idempotently or roll back safely.

### Step 3 — Publish workspace snapshots

Seal/publish an explicit current-file, selected-entry, or whole-workspace
manifest containing Markdown and assets, using inline/mailbox/R2 thresholds.
Preserve normalized relative paths, media types, byte lengths, and hashes; then
update publication state only after durable acknowledgement. Republishing never
changes the browser-local workspace source of truth.

### Step 4 — Integrate browser owner authority

Run the existing collab owner authority and owner-only accept/reject/apply paths
in the browser tab. When the owner tab is absent, comments/suggestions remain
mailbox-capable while live editing and owner actions show as paused.

### Step 5 — Build the Share sheet

Implement durability preflight, share-scope selection, TTL/mode controls, browser link, native
`attn://` link, CLI command, copy/share-sheet actions, room status, stop sharing,
and recreate-room recovery. Default to hybrid, `allowBrowser: true`, bounded
peers, and no TURN.

### Step 6 — Add native/browser interoperability

Teach entry points to present/accept the correct invite form. Native CLI may
continue receiving `attn://`; the web page offers both forms from the same room
secret. Verify browser-owner ↔ native-reviewer and browser-owner ↔ browser flows.

## Validation

- Web/Rust canonical request, room ID, signature, event, and envelope vectors.
- Relay create/register/envelope/blob tests remain fully content-blind.
- Local Playwright: browser create/share → second browser comment/suggest/edit
  → owner apply → reload/resume.
- Native Playwright/automation: browser owner → native join and native reviewer
  → browser owner, including nested Markdown, mixed image/binary assets,
  offline mailbox delivery, and WebRTC direct proof.
- Forced failure at each bootstrap step proves idempotent resume or cleanup.
- Relay log/state scans contain none of the Markdown, room secret, invite URL,
  owner private key, SDP, or ICE candidate plaintext.
