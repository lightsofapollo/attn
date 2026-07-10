# Local browser authoring

Depends on: Phase 00 and Phase 01

## Purpose

Connect the designed local desk to the storage foundation and existing attn
editor/viewer. Workspace creation, Markdown editing, and asset management stay
entirely local until Share.

## Implementation steps

### Step 1 — Add workspace service and Svelte state

Create a browser workspace service with typed load/create/import/export/edit
operations and an instance-scoped Svelte 5 state adapter. No module-level SSR
or cross-tab mutable state.

### Step 2 — Implement local home actions

Wire the landing-page New workspace action so one click atomically creates a
workspace with `untitled.md` and opens it. Add Markdown/multi-file/asset import,
recent workspaces, rename, delete, and resume. Creation must issue zero network
requests and show no naming/interstitial dialog.

### Step 3 — Wire editor autosave and revision recovery

Reuse the existing ProseMirror/Markdown stack, commit immutable revisions after
bounded debounce, flush on visibility/pagehide, recover the last committed
head, and surface save/storage/conflict status honestly.

### Step 4 — Implement multi-file and asset workspace support

Support nested multi-file workspaces, safe display paths, Markdown
create/rename/delete, binary asset add/rename/delete, relative image resolution,
safe raster preview, download-only unknown assets, individual download, and
workspace zip export. Accept multi-select everywhere, folder selection where
available, and zip as the iOS-compatible folder path. Reject traversal,
media-type spoofing, oversize input, and unsafe HTML/active-content execution.

### Step 5 — Build iOS reader, file, and review surfaces

Implement the reader-first iPhone/iPad surface from `ios-ux.md`: compact literal
state header, legible document canvas, safe media, per-file reading position,
thumb action dock, file/asset sheet, inline review anchors, thread/index sheets,
and useful view-only/native-handoff degradation. Preserve reader position and
focus across every sheet.

### Step 6 — Add iOS editing and keyboard behavior

Implement explicit edit mode, title/body edit targets, selection/comment bar,
`visualViewport`-positioned formatting controls, save state above the keyboard,
dictation/autocorrect/undo/hardware-keyboard compatibility, safe-area/rotation,
and return to the retained reader position. Editing capability may be absent
without reducing reader/reviewer quality.

## Validation

- `npm --prefix web run check`
- `npm --prefix web test`
- Playwright: landing New workspace → editor in one click → type → reload →
  edit → export → reimport, with network
  interception proving no relay request before Share.
- Nested multi-file plus raster/unknown asset and 1+ MiB body cases through both
  OPFS and IDB fallback; export/reimport preserves paths and bytes.
- Two-tab writer lease/takeover test; secondary tab cannot silently overwrite.
- Mobile Chromium/WebKit viewport suite for reader/files/review/edit/share and
  view-only at 320–430 px plus iPad/Split View widths.
- Real iPhone/iPad Safari reader, VoiceOver, safe area/address bar, rotation,
  file/review sheets, selection, keyboard/dictation, media, Web Share,
  background/kill, and browser/native handoff matrix from `ios-ux.md`.
