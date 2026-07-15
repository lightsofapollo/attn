# Rooms → Projects: fixing the "switching rooms is clunky" problem

**Status:** P1 implemented (`attn-jgz`); P2/P3 tracked for follow-up
**Prompted by:** "it's super clunky switching between rooms… maybe we don't need
'rooms' when you're the author, and we use the room concept more like a project
the user can switch to."

**TL;DR / recommendation.** Your instinct is right, and the codebase is already
~80% of the way there. The clunk is that attn ships **two navigation switchers
with the identical `ChevronsUpDown` idiom but orthogonal mental models**: a
*project switcher* (sidebar, left — switches local folders) and a *room switcher*
(floating ReviewBar, top-right — switches collab sessions). For the **author**,
"room" should stop being a place you switch into and become an *attribute of a
file* — surfaced inline in the tree they already navigate. For the **reviewer**,
a joined room genuinely *is* a project they switch into — so fold it into the one
project switcher. Net: **collapse two switchers into one axis of navigation, and
delete the top-right room dropdown entirely.**

---

## 1. The clunk, diagnosed

Today, for an author, there are two separate answers to "which document am I
looking at?":

| | Left sidebar (project switcher) | Top-right ReviewBar (room switcher) |
|---|---|---|
| Widget | `ChevronsUpDown` dropdown + Command filter | `ChevronsUpDown` dropdown + count badge |
| Switches | local directories (`knownProjects`) | collab rooms (`roomsList`) |
| Selects via | `onProjectSwitch(path)` | `reviewStore.selectRoom(roomId)` |
| Source | `Sidebar.svelte:291‑343` | `ReviewBar.svelte:144‑190` |
| Mental model | "my folders / files" | "collaboration sessions" |

They are architecturally independent. When you share a file, a **room** is minted
and it shows up in the *top-right* switcher — divorced from the *left* sidebar
where you actually navigate your work. So an author who shares three docs now
navigates their own files through **two unrelated surfaces on opposite sides of
the window**, using the same-looking control for two different concepts. That is
the clunk. It's not the dropdown's styling; it's that "room" is modeled as a
*container you enter* when, for the author, it's really just *state on a file
they own*.

The screenshot shows this stacked in one strip: `[⇅ 1]` (room switcher) · Share ·
`Document 1` (shared-files badge) · connection · snapshot — a second, parallel
navigation cluster the author has to reason about on top of their file tree.

## 2. What the code already gives us (the 80%)

The redesign is mostly *removal + rewiring*, because the primitives exist:

- **Owner-by-default already holds.** Before any room exists, the author is
  treated as owner (`App.svelte:2766`, `collabRoleFor` in `room-ui.ts:47`). The
  landing copy already commits to this model: *"A document first. A room only
  when you share."* (`HowItWorks.svelte:31`). A room is an *overlay on a file*,
  not a container the author lives in — the mental model we want is the one
  already marketed.
- **The file tree already knows what's shared.** `sharedPaths` (derived in
  `App.svelte:318`) drives an inline "shared" marker per file in `FileTree.svelte`.
  That is exactly the surface a "room = file attribute" model needs.
- **Owner vs reviewer is a per-room *role*, not a stored document owner**
  (`store.svelte.ts:80‑96`, `participantKindFor`). So "this is my doc" vs "I
  joined someone's doc" is already a runtime distinction we can branch the UX on.
- **The reviewer already gets a file tree of the room in the sidebar**
  (`ReviewFileTree.svelte`, mounted in `Sidebar.svelte:414` under `reviewMode`).
  A joined folder-share *already renders as a project-like tree on the left* —
  the room switcher is only load-bearing when a reviewer joins **multiple** rooms.
- **One component serves both builds.** The same `ReviewBar` is mounted in native
  (`App.svelte:2764`) and hosted (`HostedDesktopWorkspaceFrame.svelte:99`), so a
  single change fixes web and native together.

## 3. Proposed model — one axis of navigation

**Principle: the author never "switches rooms." They switch files, and sharing
travels with the file.** Collaboration (peers, comments, connection, snapshot)
attaches to *whatever shared file is focused*, not to a room you select.

Concretely, split by role:

### Author (owner) — rooms disappear as navigation
- **Delete the top-right room switcher** for owners. An owner does not pick a
  room; they open a file like any other, and if it's shared, the collab surface
  lights up for that file.
- **Sharedness becomes a file-tree state.** The existing `sharedPaths` marker is
  promoted: a shared file shows a quiet "shared" glyph, and any per-doc **unread
  count moves onto the file row** (today the top-right dropdown aggregates
  `totalUnread` across rooms — that badge belongs on the specific file in the
  tree, which is more spatially honest anyway).
- **The ReviewBar keeps only per-document status** — connection badge, peer
  strip, snapshot, outbox, and the Share pill. All of these are already
  *about the focused doc*, not a switcher. Nothing here needs a room list.
- **Sharing stays a property, not a mode.** `Cmd+Shift+S` still mints/reshows the
  invite for the focused file (`ShareDialog` is unchanged). The difference: after
  sharing, you don't gain a room to manage — the file just reads as "shared."

### Reviewer — a joined room *is* a project
- A reviewer who joins a share is entering someone else's workspace. That maps
  cleanly onto "project." **Fold joined rooms into the sidebar project switcher**
  (`onProjectSwitch`), so the *single* left-hand switcher lists local projects
  **and** joined shared projects. `ReviewFileTree` already provides the tree body.
- The **only** legitimate multi-room switch — a reviewer in several shares —
  becomes "switch project," using the control they already use for folders. No
  second switcher, no opposite corner of the window.

### Result
- **One switcher** (left sidebar), one mental model ("which workspace am I in"),
  and rooms demoted to a file attribute for the author / a project entry for the
  reviewer. The top-right room dropdown is deleted, not restyled.

## 4. Before / after chrome

```
BEFORE (author, 3 shared docs)
┌ sidebar ─────────┐                              top-right ReviewBar
│ ⇅ my-project     │        …document…      [⇅ 3][Share][Document 1][●conn][snap]
│  ├ plan.md  ◍     │                          └── room switcher (parallel nav)
│  ├ spec.md  ◍     │
│  └ notes.md       │
└──────────────────┘

AFTER (author)
┌ sidebar ─────────┐                              top-right ReviewBar
│ ⇅ my-project     │        …document…            [Share][●conn][peers][snap]
│  ├ plan.md ◍ ②    │                             └── per-DOC status only, no switcher
│  ├ spec.md ◍      │        (open plan.md → its collab surface lights up)
│  └ notes.md       │
└──────────────────┘   ◍ = shared   ② = unread on that doc

AFTER (reviewer, joined 2 shares)
┌ sidebar ─────────┐
│ ⇅ acme-review ▾  │   ← same project switcher now also lists joined rooms
│  ├ (shared tree) │
└──────────────────┘
```

## 5. Web + native

Same `ReviewBar` in both builds, so the switcher removal lands once. Two
build-specific notes:

- **Hosted** already has room *persistence/erasure* UI
  (`listRememberedRooms`/`forgetRoom`, crypto-erase, surfaced in
  `StoragePage.svelte`). Under the project model, "forget room" becomes "remove
  this shared project" — a natural fit for a project-list overflow action rather
  than a storage-settings page.
- Hosted uses a `ShareSheet` bottom-sheet vs native's `ShareDialog` modal; both
  are per-file share entry points and are unaffected by dropping the switcher.

## 6. Concrete touch-points (when we schedule it)

- `web/src/lib/ReviewBar.svelte` — remove the `rooms.length > 0` `DropdownMenu`
  block (`:144‑190`); keep Share pill + status slots. This is the core deletion.
- `web/src/lib/FileTree.svelte` — add unread badge to shared rows (data already
  in `reviewStore.unreadForRoom` + `sharedPaths`); relocate `totalUnread`.
- `web/src/lib/Sidebar.svelte` — extend `projectOptions` (`:117`) to include
  joined rooms for reviewers; route their selection through `onProjectSwitch`.
- `web/src/App.svelte` — map roomId→project-scope so `selectRoom` and
  `applyTabScopeForProject` share one path; owner rooms stop feeding a switcher.
- `web/src/lib/review/room-ui.ts` — `shouldAutoSelectOnlyRoom` already
  auto-selects a lone room; generalize so an owner's rooms never need explicit
  selection at all (focus-follows-file).
- Landing copy (`HowItWorks.svelte`) already aligns — no change, maybe reinforce.

## 7. Risks & open questions

1. **Author with a shared doc *outside* the open project.** Everything an owner
   shares is a local file in *some* project, but if it's not the active one, the
   unread badge lives in a collapsed project. Mitigation: a small "shared" filter
   / section at the top of the tree, or surface cross-project unread on the
   project switcher itself.
2. **Losing the room roster.** The dropdown is also the only place an owner sees
   "these are all my live shares at once." If that overview has value, it becomes
   a *filter* ("Shared") in the existing sidebar, not a separate switcher.
3. **Leave / stop-sharing discoverability.** Today "Leave current room" lives in
   the dropdown we're deleting. It moves to the file row's context menu (owner:
   "Stop sharing"; reviewer: "Leave / forget project").
4. **Multi-file rooms (folder shares).** A folder share is one room over many
   files. As a "project" this is natural; as a per-file attribute we mark every
   contained file shared (already how `sharedPaths` works). Confirm the unread
   badge rolls up sensibly to the folder row.
5. **Reviewer with zero local files.** Already handled — reviewer gets the
   sidebar shell even on an empty dir (`App.svelte:219`); their joined room simply
   *is* the project.

## 8. Suggested phasing (small, reversible)

- **P1 — author:** delete the owner-side room dropdown; move unread onto tree
  rows; keep ReviewBar status slots. Highest clunk-reduction, lowest risk.
- **P2 — reviewer:** fold joined rooms into the project switcher; move
  leave/forget to the project list.
- **P3 — polish:** cross-project "Shared" filter, folder-share unread roll-up,
  reconcile hosted `forgetRoom` into the project-remove action.

Each phase is independently shippable and reversible, which fits "converge, don't
proliferate": we're removing a navigation surface, not adding one.

## 9. Implementation status

- **P1 (`attn-jgz`) — implemented.** Owner collaboration now follows the active
  local path, opening an unshared file clears the collaboration presentation
  without forgetting room data, owner room navigation is removed from the
  ReviewBar, and per-room unread counts appear once on the corresponding
  file/folder row. The hosted desktop frame uses the same owner-only ReviewBar
  behavior and tree badges. Reviewer switching remains temporarily unchanged.
- **P2 (`attn-zqt`) — filed.** Promote joined reviewer rooms into the sidebar
  project switcher and move leave/forget actions onto those project entries.
- **P3 (`attn-nls`) — filed.** Add cross-project shared/unread discovery, finish
  folder-share and stop-sharing polish, and reconcile hosted room erasure with
  project removal.
