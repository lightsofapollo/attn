# Real iOS Safari release protocol

Date: 2026-07-11 (attn-7xl.6.5)
Status: required before any production attn.sh rollout — Playwright WebKit is
supplementary and can never waive this matrix.

## Supported targets

- **iOS/iPadOS: current major and previous major** (at rollout time). Older
  versions get the honest capability degradation, not support commitments.
- Devices: one small iPhone (SE/mini class), one current iPhone, one iPad
  (Split View capable).
- Browsing modes per device: normal tab, Private Browsing, installed Home
  Screen app (from `/manifest.webmanifest`).

## Session checklist (per device × mode)

Record evidence per row in the relevant Bead (attn-7xl.2.9 for storage,
attn-7xl.7 for the rollout matrix). Staging origin: `https://staging.attn.sh`.

### Storage & durability (attn-7xl.2.9)

1. Create a workspace, type, wait for "Saved on this device", kill Safari from
   the app switcher, reopen → last committed revision present.
2. Private Browsing: desk shows "This session only" + degraded banner; create
   + export works; closing the private session and reopening shows the honest
   empty state; the exported zip re-imports intact.
3. Home Screen app: create → force-quit → relaunch → content present; check
   `navigator.storage.persisted()` before/after install.
4. Deny/ignore the persistence prompt → badge shows "Backup recommended";
   share sheet requires the risk acknowledgement.
5. Settings → Safari → Clear History and Website Data → reopen: desk is empty,
   copy is accurate (no phantom workspaces), previously exported backups
   re-import.
6. Low storage: fill the device near quota (or use a small-quota profile) and
   confirm quota-pressure UI pauses writes without corrupting the last head.

### Reader / editing (attn-7xl.3.x follow-through)

7. Reader at 320–430 pt: measure, no page panning, dock reachable with the
   address bar collapsed and expanded; rotation preserves position.
8. Files/Review sheets: open/close preserves exact scroll; VoiceOver announces
   sheet titles; focus returns to the invoking control.
9. Edit mode: keyboard raises the formatting bar (visualViewport), save state
   stays visible, dictation + autocorrect + undo + hardware keyboard (iPad)
   work; Done returns to the retained reading position.
10. Safe raster lightbox pinch-zooms natively; unknown assets stay
    download-only; downloads land in Files and re-import via the picker.

### Offline / lifecycle (attn-7xl.6.x)

11. Airplane mode after one online visit: the app launches from the SW shell,
    local workspaces open, edits autosave; going online resumes cleanly.
12. Update flow: deploy a new staging build, revisit → new version activates
    (post-`attn-shell-updated` message), no stale-shell lockup.
13. Backgrounding mid-edit → return after >30 s: lease/heartbeat recovers or
    honestly re-acquires; no zombie writes from the suspended state
    (fencing token check).
14. Web Share sheet export (when wired), open-in-native handoff from the dock.

### Review links (with attn-7xl.4)

15. Native-generated `https://staging.attn.sh/review/<id>#key=…` opens the
    reader directly; the fragment never reaches history/UI; owner-offline copy
    is honest; Private Browsing can review in-memory.

## Recording

For each row: device, OS version, mode, pass/fail, screenshots into
`planning/web-authoring/device-evidence/` (git-lfs not required; keep shots
small), and a one-line note in the closing Bead comment. Any failure blocks
the attn-7xl.7 cutover until fixed or explicitly waived by the owner.
