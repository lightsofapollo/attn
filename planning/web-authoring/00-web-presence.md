# Unified web presence and route shell

Depends on: none

## Purpose

Turn the current native-first marketing site and review-only hosted app into one
coherent presence. This phase establishes routes, visual language, and bundle
boundaries; it does not add browser document persistence yet.

## Page designs

### `/` — landing

Hero copy shifts from “install a native Markdown viewer” to:

> **A private desk for working documents.**
> Write in the browser or open local Markdown in native attn. Share a link when
> it needs another pair of eyes. No account, and no server can read the words.

Primary CTA: **New workspace** → atomically create a workspace with
`untitled.md`, then open its editor in the same click.

Secondary CTA: **Open your desk** → `/app`; native install remains in navigation
and its existing lower-page section.

The live document/review composition remains the visual hero. Replace the
generic feature sequence with a three-part story:

1. **Create locally** — “Stored on this device.”
2. **Share deliberately** — “A room exists only after Share.”
3. **Work anywhere** — Browser or native, direct when reachable, encrypted
   mailbox otherwise.

Keep GitHub and install commands, but move them below the browser CTA. Remove
copy that says “No browser tab,” because the browser is now a first-class
surface.

### `/app` — local workspace home

No avatar, team switcher, subscription, or login. Header states **On this
device** and shows a small storage health mark.

Primary actions:

- **New workspace** (one click; starts with `untitled.md`)
- **Import workspace** (Markdown, images/assets, multi-select, folder where
  supported, or zip)
- **Join a review** (paste/open a link; secondary)

Recent workspaces are typographic rows with title, Markdown/asset count, last edited,
sharing state, and local durability. Empty state contains a half-written
Markdown sheet rather than an illustration.

### `/app/w/:workspaceId/:fileId` — authoring

Desktop composition:

- 240 px local file rail
- flexible reading/editing sheet
- 320 px review margin when open
- thin top bar with local save state, connection state, and Share
- file rail distinguishes editable Markdown from previewable/download-only
  assets while preserving relative paths

Mobile/iPhone composition:

- file switcher in a top sheet
- document fills the viewport
- comments/suggestions open in a bottom sheet
- Share and save state remain visible in the compact header
- safe-area insets and virtual-keyboard resizing are explicit requirements

Status language:

- `Saved on this device`
- `Saving…`
- `Storage needs attention`
- `Shared · Direct`
- `Shared · Encrypted relay`
- `Owner offline · Review still available`

### Share surface

Share is a focused sheet, not a settings form. First share proceeds through:

1. **Keep the source safe** — persistence result and Markdown backup action.
2. **Choose access lifetime** — sensible default (24 hours hybrid), advanced
   options collapsed.
3. **Choose what to share** — current file, selected files/assets, or the whole
   workspace, using the same manifest and relative paths as native attn.
4. **Link ready** — browser link first, “Open in native attn” and CLI copy
   second. Explain that the secret is in the fragment and cannot be recovered
   by attn services.

### `/app/storage` — storage & recovery

One calm operational page:

- persistence mode and browser explanation
- bytes used / estimated quota with accessible text
- workspace list with Export and Delete
- Export all Markdown
- Import backup
- Clear all local attn data (destructive confirmation)
- installed-app guidance on iOS when persistence is best-effort

### Failure and degraded states

- **Private browsing:** “This private session may erase your desk when it
  closes.” Offer scratch editing plus export; never imply durability.
- **Lockdown/capability failure:** “This browser currently blocks local
  document storage.” Keep invite review available if its in-memory prerequisites
  work.
- **Quota pressure:** block destructive writes, preserve last committed head,
  offer export/prune, and never silently overwrite.
- **Lost share capability:** local document remains; create a new share room.

## Implementation steps

### Step 1 — Add hosted multi-entry routing

Create landing, app, and review HTML/Svelte entries in `web/hosted`; add a
minimal path router/worker rewrite for deep `/app/*` and `/review/*` URLs. Keep
route bundles lazy so landing does not load editor/crypto code.

### Step 2 — Migrate and revise the landing

Move the reusable `site/src/lib` design language into
`web/src/hosted/landing`. Update copy, CTAs, collaboration claims, metadata,
and mobile navigation for browser authoring. The primary New workspace action
must create-and-open in one click. Preserve self-hosted fonts and light/dark themes.

### Step 3 — Build the local workspace shell

Implement non-persistent visual shells for `/app`, editor, Share, storage, and
degraded states using typed props and Svelte 5 runes. Use an injected mock
workspace service so frontend iteration stays independent of storage work.

### Step 4 — Retire the split landing deployment

Add redirect/cutover documentation and remove Vercel ownership only after the
Cloudflare hosted build matches metadata, screenshots, and install links.

## Validation

- `npm --prefix web run check`
- `npm --prefix web test`
- `npm --prefix web run build:browser`
- Route-level bundle inspection: landing must not preload ProseMirror,
  Mermaid, KaTeX, room crypto, or WebRTC chunks.
- Playwright desktop + iPhone-sized screenshots for all five designed pages and
  every degraded state.
- Keyboard-only and axe-style accessibility audit; no horizontal scrolling at
  320 CSS px.
- Cloudflare preview verifies `/`, `/app`, deep workspace paths, and dynamic
  `/review/:roomId` routing under the same origin and CSP.
