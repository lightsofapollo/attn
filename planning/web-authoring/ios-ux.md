# iOS web experience

Date: 2026-07-10
Status: approved design direction
Prototype: [interactive iPhone experience](ios-experience.html)

## 1. Product posture

The iOS web surface is a reader/reviewer first and an editor second. It must
never look or behave like the desktop three-column workspace compressed into a
narrow viewport. Opening a local workspace or review link lands in the
document. Files, review, editing, and sharing arrive as focused modes without
permanently competing with the words.

This ordering is also the graceful-degradation strategy. If local persistence,
writer ownership, memory, or editing capabilities are unavailable, attn can
still provide an excellent view of a shared encrypted workspace. The user loses
only the action the browser cannot safely perform; they do not fall into a
generic unsupported-browser page.

Principles:

1. **The document is the app.** Reading owns the viewport.
2. **One thumb away.** Files, review, edit/native, and share live in the bottom
   action dock.
3. **Sheets, not sidebars.** Temporary navigation preserves document position.
4. **View-only is useful.** Files, safe media, comments, export, sharing, and
   native handoff remain available.
5. **State is literal.** “Saved on this device,” “Shared · encrypted relay,” and
   “Viewing safely · editing unavailable” replace vague online/offline labels.
6. **No gesture traps.** Browser back, scrolling, text selection, and pinch zoom
   win over clever custom gestures.

## 2. Entry flows

### Landing → New workspace

One tap on **New workspace** atomically creates a workspace containing
`untitled.md` and routes to the edit surface. Do not show a naming page or
dialog. Because iOS may not preserve keyboard activation through an asynchronous
IndexedDB transaction and navigation, the empty editor says **Tap to start
writing**; it does not promise to open the keyboard automatically.

If durable storage creation fails, offer a clearly labeled scratch document
that can be exported but not shared until the durability gate is acknowledged.

### Desk → recent workspace

Opening a recent workspace lands in reader mode at the last file and a
best-effort saved reading position. The desk is a short local index, not a
dashboard: New workspace, Import workspace, Join a review, recent rows, and one
storage-health link.

### Review link → shared reader

`/review/:roomId#key=…` strips the fragment before rendering content or loading
subresources, joins the room, and opens the shared reader at the invite's target
file/anchor when present. Joining does not first route through the desk.

Loading stages are content-shaped rather than spinner-only:

- validating invite
- opening encrypted room
- decrypting workspace manifest
- opening `<path>`

Failure preserves useful context: invalid/expired link, unsupported crypto,
owner offline with mailbox still available, or network unavailable with a
remembered sealed snapshot.

## 3. Reader anatomy

The phone reader has four persistent regions:

1. **Safe-area status region** — owned by iOS/Safari or the installed Web App.
2. **Compact document header** — back, truncated workspace/file identity,
   literal local/share state, and Share.
3. **Document canvas** — a single scroll surface with no horizontal page
   chrome.
4. **Bottom action dock** — Files, Review, Edit (or Open native), and Share.

Reading defaults:

- 18–19 CSS px body text, 1.65–1.75 line height
- 20–25 px horizontal measure on an iPhone portrait viewport
- Source Serif for rendered prose and Source Code for code/status
- headings scale by available width, never desktop viewport width
- code blocks scroll internally with a visible affordance
- tables may pan inside their own framed region; the page never pans
- task lists, footnotes, math, and Mermaid retain semantic alternatives
- remember scroll position per workspace/file, but an explicit anchor/deep link
  wins on open

The header can compact while scrolling down and restore on upward intent, but
the bottom dock remains reachable. With VoiceOver or reduced motion, the header
does not animate away.

## 4. Files and assets

Files open in a bottom sheet sized to content up to roughly 82% of the visual
viewport. The sheet lists normalized relative paths and groups editable
Markdown separately from assets without pretending they are different
workspaces.

Each row communicates:

- type and safe-preview capability
- relative path (not just basename)
- byte size and last local edit/publication state
- active file

Selecting another Markdown file closes the sheet and restores that file's last
reading position. Selecting an asset opens the appropriate viewer:

- raster image: edge-to-edge lightbox, native pinch zoom, share/download
- audio/video: native controls over a short-lived decrypted object URL
- safe text/data: syntax/plain preview with download
- unknown or active format: metadata plus download/open-native only

No imported asset is navigated as same-origin active content. Missing relative
references show a placeholder containing the unresolved path and an action to
open the Files sheet; they never silently fetch an arbitrary remote URL.

## 5. Mobile review

Desktop margin cards become inline anchors plus a review sheet.

- A highlighted text range carries a numbered, at-least-24 px marker.
- Tapping the range or marker opens its thread without losing scroll position.
- **Review · N** opens the review index, ordered by document position with an
  Unanchored section.
- The thread sheet shows the anchor quote, messages, suggestion diff, resolve
  state, and reply composer.
- Closing returns focus to the invoking anchor and keeps the exact reading
  position.

Text selection exposes a compact native-feeling action bar: Comment, Suggest
(when editing authority permits), Copy. It must not replace the iOS selection
menu until a reliable selection exists.

Owner actions:

- Small suggestion diffs can be accepted/rejected in the thread after a clear
  before/after preview.
- Drifted or structurally large applies route to a dedicated comparison or
  native attn; never hide conflict detail inside a narrow card.
- When the browser owner is offline, reviewer copy says “Owner offline · review
  will deliver” and disables only live/owner-authority actions.

## 6. Editing

Editing is an explicit mode, not the default reader state. The reader's scroll
position is retained when entering and leaving it.

Editor requirements:

- document title and body are separate accessible edit targets
- toolbar sits immediately above the visual keyboard using `visualViewport`,
  not a guessed fixed keyboard height
- formatting actions meet 44 × 44 CSS px touch targets
- save/share state remains visible above the keyboard
- selection, autocorrect, dictation, undo, and hardware keyboard commands work
- file/review sheets dismiss or resize before the keyboard; they never stack
  under it
- autosave commits immutable revisions after bounded debounce and on
  visibility/pagehide, but “Saved” appears only after IndexedDB commit
- rotation and process restart recover the last committed revision

If editing is not available, the reader dock replaces **Edit** with **Open
native**. A compact non-modal banner explains the exact cause and retains
Export. Review replies can remain enabled if their encrypted outbox capability
works independently.

## 7. Sharing and native handoff

Share is a bottom sheet with an iOS-sized decision sequence:

1. durability result/backup action when required
2. scope: current file, selected entries, or workspace
3. concise manifest summary: Markdown count, previewable assets, download-only
   assets, and total bytes
4. TTL/mode summary with advanced controls collapsed
5. primary **Share link…** using the Web Share API where available, then copy
   fallback

Native and CLI forms are secondary actions from the same room secret. **Open in
native attn** is explicit; do not automatically throw the user into a custom
scheme prompt. Returning from native must not create a second browser room.

The share sheet and iOS share activity must never put the invite fragment into
analytics, logs, document referrers, recent-search suggestions, or service
worker caches.

## 8. Storage, offline, and install

The desk header uses one small state:

- **On this device** — persistence granted
- **Backup recommended** — best-effort
- **This session only** — volatile/private session
- **View-only** — local workspace storage unavailable

Warnings are actionable and do not sit permanently over the document. The
first-share durability gate is the strong intervention point.

Home Screen installation is optional. Offer instructions after demonstrated
intent (for example, the second local-workspace return or an explicit Offline
action), not as a landing-page modal. Copy may say it can improve offline launch
and persistence behavior, never that it guarantees data retention.

Offline reader behavior:

- remembered sealed local/shared content can render
- a non-remembered invite cannot be reconstructed without its fragment
- local edits save to IndexedDB without waiting for transport
- review outbox reports queued state
- direct/WebRTC state becomes unavailable without implying content loss
- no background-sync or closed-tab room-authority promise

## 9. Capability matrix

| Mode | Read local | Read invite | Files/assets | Review | Edit | Share |
|---|---:|---:|---:|---:|---:|---:|
| persistent | yes | yes | full | full | yes | yes |
| best effort | yes + backup cue | yes | full | full | yes | durability gate |
| volatile/private | scratch only | current session | in-memory | if crypto/transport work | optional scratch | explicit risk + export |
| IndexedDB blocked | no local desk | in-memory when crypto works | room manifest only | session-only | no | no ownership persistence |
| low memory/large asset | yes | yes | metadata + on-demand body | yes | yes for Markdown | size-aware |

Capability checks, not Safari version or user-agent strings, choose the row.

## 10. iPad

iPad is not a stretched phone. In regular-width portrait/landscape:

- reader measure remains capped and centered
- Files may become a persistent leading column only when it leaves at least a
  640 px reading canvas
- Review remains a sheet/popover by default; a trailing rail is user-toggled
- hardware keyboard shortcuts mirror native where safe
- multiwindow/Split View is tested down to compact width and falls back to the
  phone layout without losing state

## 11. Accessibility and platform behavior

- Use semantic article/nav/dialog structures and real headings.
- Sheets trap focus, announce their title, support Escape/hardware keyboard,
  and restore focus to the invoking control or anchor.
- All controls meet a 44 px target even when their visual icon is smaller.
- Support browser text scaling to 200% without clipping, overlap, or horizontal
  page scroll.
- Respect reduced motion, increased contrast, and light/dark preferences.
- Never rely on hover, force custom pull-to-refresh, or intercept edge-back.
- Use `100dvh`, safe-area environment insets, and `visualViewport`; test Safari
  top/bottom bar expansion rather than assuming a stable viewport.

## 12. Required validation

Playwright Chromium/WebKit at 320, 375, 390, 430, iPad portrait, and iPad Split
View widths:

- link → reader → file → exact anchored thread → close without scroll loss
- inline raster and unknown-asset behavior
- reader → edit → keyboard-size simulation → save → reader
- persistent and view-only docks expose the correct actions
- share-scope summaries for one, selected, and whole workspace
- no page-level horizontal scroll and no obscured control at 200% text scale

Real current iPhone and iPad Safari is mandatory for:

- normal tab, Private Browsing, and Home Screen app
- dynamic address bars, safe areas, rotation, Split View
- VoiceOver rotor/focus and external keyboard
- selection menu, comment action, dictation, autocorrect, undo
- Files/zip import and export, Web Share, image pinch zoom
- background/foreground, process kill, low memory, low storage, site-data clear
- browser/native invite handoff and return

The release may ship view/review before mobile editing only if every view-only
criterion passes and the UI labels editing as unavailable rather than “coming
soon” or broken.
