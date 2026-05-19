# Connection + Share Affordances

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.3).
Blocks: attn-nnj.4.10 (share), 4.11 (connection badge), 4.12 (peer strip).

References:

- `planning/collab/ui/review-panel-design.md` (10.1) — flat-with-chips review
  panel mounts in the right-rail `<aside>` (App.svelte:1448-1462). 10.1's
  panel header recommendation (lines 378-379) includes "connection badge";
  this design must coordinate, not duplicate.
- `planning/collab/ui/inline-decorations.md` (10.2) — not yet merged. This
  design treats decorations as independent (chrome lives outside the editor
  surface) so the two issues can ship in either order.
- `planning/collab/data-model.md` §UI/UX Changes (lines 776-814) — surface
  inventory: share, room mode, connection badge, peer strip, snapshot badge.
- `planning/collab/amendments.md` Decision #1 (agentic collab is primary —
  peer strip must distinguish agents from humans visually), Decision #8
  (`longSession` 7d opt-in), Decision #12 (`deleteEventsAfterOwnerAck` opt-in).
- `planning/collab/crypto-spec.md` §Out-of-Band Verification (line 400-402):
  display `SHA-256(ownerSigningKey)` truncated to 12 hex chars.
- `web/src/App.svelte` lines 1294-1308 (header chrome), 1448-1462 (right-rail),
  1153-1168 + 1479 (global `Cmd+J` toggle).
- `web/src/lib/TabBar.svelte` — 40 px strip, hidden when ≤ 1 tab.
- `web/src/lib/PathBreadcrumb.svelte` — 40 px row; sidebar-hidden mode reserves
  6.5 rem left padding for macOS traffic lights.
- `web/src/app.css` lines 76-87 / 156-166 — `--peer-avatar-bg-{owner,reviewer,
  agent}`, `--panel-surface`, `--panel-border`. **Do not invent CSS vars.**
  Connection badge reuses `--primary` (Live), `--muted-foreground` (Mailbox /
  Offline), `--destructive` (Direct failed).

---

## 1. Real Estate Audit

```text
┌── tao window ────────────────────────────────────────────────────────────────┐
│ ┌── Sidebar (resizable) ──┐┌── SidebarInset ────────────────────────────────┐│
│ │ ⊕ project ▾   ⌕  ☼ ✎  ││ [TabBar] file.md  one.md  two.md         ← 40px ││ only when >1 tab
│ │                         ││ ▸ planning › collab › ui › conn-share.md ← 40px││ PathBreadcrumb
│ │ ▸ planning              ││ ┌── ScrollArea (editor / viewer) ───────────┐  ││
│ │   ▾ collab              ││ │ # heading…                                 │  ││
│ │  [outline]              ││ │ paragraph…                                 │  ││
│ │  Files | Outline        ││ └────────────────────────────────────────────┘  ││
│ └─────────────────────────┘└────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
                                                            ↑ right-rail aside
                                                              360px when open
                                                              Cmd+J toggles
```

Key facts:

- **TabBar (40 px)** — only when `tabs.length > 1` (App.svelte:1295-1297).
- **PathBreadcrumb (40 px)** — sidebar-hidden mode is `fixed` with 6.5 rem
  left padding for the traffic lights (PathBreadcrumb.svelte:69-75).
- **Theme / font / edit toggles, command palette do not live in the top bar.**
  They are inside the Sidebar header (Sidebar.svelte sidebar-controls panel)
  or modal (`CommandPalette.svelte`, App.svelte:1481-1488). The top bar today
  only carries tabs and breadcrumb — **no horizontal toolbar contention.**
- **Right-rail aside** — 360 px open / 0 px closed, width-transitioned, mounts
  the `rightRail` snippet prop. Already designated for ReviewPanel per 10.1.
- **`Cmd+J`** — toggles `reviewStore.panelOpen` (1153-1168).

**Implication:** the top of the SidebarInset is uncrowded; the question is
where new chrome lives without becoming a third 40 px row, and how it
behaves when no review session is active (most of the time — chrome must be
invisible).

---

## 2. The Three Affordances

- **Share button (owner-only).** Opens the §6 dialog. While a room is bound
  to the active file, mutates into `[ ⊜ Sharing ]` and opens the same dialog
  pre-populated.
- **Connection badge.** Always visible when a session is bound. Four states
  per `data-model.md` §UI/UX: Live direct / Mailbox / Offline / Direct failed
  (§5).
- **Peer strip.** Avatar chips for owner + reviewers + agents. Click reveals
  presence/last-active. Agent shape is visually distinct from human (§7).
  Agentic collab is primary (amendments #1), so an agent must not look like
  a "minor" participant.

---

## 3. Three Candidate Placements

Each candidate is mocked at typical (~120 cols) and narrow (~60 cols) widths.

### Candidate (a): Inline in the existing top bar

Share + badge sit between the breadcrumb and the right edge. Peer strip
stacks as a second 36 px row beneath the breadcrumb when active.

```text
Typical (~120 cols), session active:
│ [TabBar] basic.md  typography.md                                                           │
│ ▸ planning › collab › ui › conn-share.md          [Share]  [● Live direct]                 │ ← +chrome on breadcrumb row
│ 👤james  🤖rufus  👤alex                                                                   │ ← peer strip (+36 px)
│ ┌── editor ──────────────────────────────────────────────────────────────────────────┐    │

NO session:
│ ▸ planning › collab › ui › conn-share.md                                       [Share?]    │ ← always-on Share = noisy
│ (peer-strip row absent — but presence/absence shifts layout)                               │

Narrow (~60 cols), session active:
│ ▸ … › conn-share.md         [Share] [● Live]                │ ← breadcrumb truncates harder
│ 👤j 🤖r 👤a +1                                              │
```

Pros: always visible without panel open; familiar Figma-style placement.
Cons: **steals breadcrumb width** (the breadcrumb already overflows on deep
paths); peer-strip row toggles layout on session start (chrome shift); share
button vanishing for reviewers leaves a dead right edge.

### Candidate (b): Dedicated "review bar" row

A 36 px header row appears **only** when a review session is bound to the
active file. Contains share (owner) + badge + peer strip. Otherwise the
viewer is byte-identical to today.

```text
Typical (~120 cols), session active:
│ [TabBar] basic.md  typography.md                                                           │
│ ▸ planning › collab › ui › conn-share.md                                                   │
│ [Share]  ● Live direct  ·  👤james  🤖rufus  👤alex                          [snap @14:02] │ ← review bar (+36 px)
│ ┌── editor ──────────────────────────────────────────────────────────────────────────┐    │

NO session:
│ [TabBar]                                                                                   │
│ ▸ planning › collab › ui › conn-share.md                                                   │
│ (review-bar row absent — zero chrome change from today)                                    │
│ ┌── editor ────────────────────────────────────────────────────────────────────────────┐  │

Narrow (~60 cols), session active:
│ [TabBar]                                                   │
│ ▸ … › conn-share.md                                        │
│ [↗] ● Live  ·  👤j 🤖r 👤a +1                ⓘ snap        │ ← share collapses to icon
│ ┌── editor ─────────────────────────────────────────────┐  │
```

Pros: **non-intrusive when idle** (no chrome); owner/reviewer asymmetry is
contained in one row (Share slot collapses for reviewers, row stays);
narrow-window resilient (own overflow rules, no breadcrumb contention).
Cons: 116 px of total chrome when tabs are also visible (40 + 40 + 36) —
acceptable; risk of duplication with 10.1's panel header (resolved in §8 by
having the panel drop the badge).

### Candidate (c): Right-rail header (panel-owned)

Share, badge, peers anchor to the **top of the right-rail review panel**
(extending 10.1's header). Main toolbar gets a 12 px connection-badge
mini-mirror in the breadcrumb row's right edge so out-of-panel users still
see status.

```text
Typical (~120 cols), session active, panel open:
│ [TabBar] basic.md  typography.md                              ││ Review · 23 open · 4 sugg   │
│ ▸ planning › collab › ui › conn-share.md            [●]       ││ [Share]  ● Live direct      │
│ ┌── editor ─────────────────────────────────────────────┐    ││ 👤james  🤖rufus  👤alex    │
│                                                                ││ ────────────────────────── │
│                                                                ││ ▼ all  ▼ open  sort: new ⌕ │
                                                              ↑ 12 px mini-badge: color only

Typical, panel CLOSED, session active:
│ ▸ planning › … › conn-share.md                                              [● 3]  ⌘J       │

Narrow (~60 cols), session active, panel open:
│ ▸ … › co… [●]           ││ [Share] ● Live  👤j 🤖r 👤a +1    │ ← editor crushed to ~140 px,
│ ┌─editor┐               ││ thread cards…                     │   effectively unusable
```

Pros: strongest coherence with 10.1 (one spatial home for "review"); idle
state is zero chrome plus a 12 px dot.
Cons: **narrow window: panel open = editor unusable** (~140 px); share
button gated behind `Cmd+J` (discoverability); mini-badge is color-only
(color-blind users must hover); reverses 10.1's own statement (line 392)
that "share button is separate, in the toolbar — not in the panel."

---

## 4. Owner vs Reviewer Asymmetry

Same chrome component for both roles; conditional rendering inside.

| Element              | Owner                              | Reviewer                                           | Agent (CLI)          |
|----------------------|------------------------------------|----------------------------------------------------|----------------------|
| Share button         | **Visible** while session bindable | **Absent** — slot collapses (not just hidden)      | n/a — no chrome      |
| Connection badge     | Visible (4 states, §5)             | Visible (4 states, §5)                             | n/a                  |
| Peer strip           | reviewers + agents                 | owner + co-reviewers + agents (self badged `(you)`)| n/a                  |
| Snapshot banner      | inline snapshot age (4.9 owns)     | banner when on a snapshot ≠ owner's current (4.9)  | n/a                  |
| Outbox indicator     | n/a                                | "N pending" if mailbox-mode + offline (out of scope)| n/a                 |

Two rules to keep conditional logic predictable:

1. **Slot collapse, not visibility hide.** Reviewer's missing Share slot
   reflows; no reserved empty space.
2. **No mode toggles.** Owner cannot "preview as reviewer" from the toolbar
   in v2.

Agent CLI participants are headless — chrome is `attn review …` output. The
peer strip on humans' screens is the only place an agent is represented
visually.

---

## 5. Connection Badge State Model

Four states, one chip. Click → popover with peer-by-peer transport detail
and a `[reconnect direct]` button. Existing CSS vars only.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ State          Icon  Label            Color           Tooltip       │
├──────────────────────────────────────────────────────────────────────┤
│ Live direct    ●     "Live direct"    --primary       Realtime via  │
│                                       (warm/steel)    DataChannel   │
│ Mailbox        ◐     "Mailbox"        --muted-fg      Async via     │
│                                       (neutral)       relay         │
│ Offline        ○     "Offline"        --muted-fg      No transport; │
│                                       (dim)           queueing N    │
│ Direct failed  ⚠     "Direct failed"  --destructive   Live mode     │
│                                       (red)           requested,    │
│                                                       DataChannel   │
│                                                       could not     │
│                                                       connect       │
└──────────────────────────────────────────────────────────────────────┘
```

Popover (click):

```text
┌── Connection ─────────────────────────────────┐
│ ● Live direct                                 │
│ ────────────────────────────────────────────  │
│ 🤖 rufus     direct        rtt 18 ms          │
│ 👤 alex      direct        rtt 42 ms          │
│ 🤖 lint-bot  mailbox       last push 14:01    │
│ ────────────────────────────────────────────  │
│ Relay: attn.dev/v2     [reconnect direct]     │
└───────────────────────────────────────────────┘
```

**"Direct failed" — actively interrupt, but only once.** In
`policy.mode == "live"`, the reviewer asked for live; silent fallback would
violate intent. But interruption ≠ modal:

- Badge renders `--destructive`.
- One-time toast: "Live connection failed. Switch to Mailbox?" with
  `[switch]` `[retry]` `[dismiss]`.
- After dismiss the red badge persists silently. Popover has `[retry
  direct]`. Toast does **not** re-fire on the same failure within the room
  session.

`hybrid` mode degrades silently to Mailbox (`◐`). `async` modes start at
Mailbox; Direct is not a concept.

---

## 6. Share Dialog

Modal dialog (form is tall — inline popover would feel cramped; CLAUDE.md
"no `window.confirm`/`alert`" allows both, modal preferred for a
consequential action with focus capture).

```text
┌─────────────────────── Share for review ────────────────────────┐
│                                                                 │
│  File: planning/collab/ui/conn-share.md                         │
│                                                                 │
│  Mode  (◉) Live           realtime, peers required online       │
│        ( ) Async 24h      mailbox, expires in 24h               │
│        ( ) Async 7d       mailbox, expires in 7d   (longSession)│
│        ( ) Hybrid         live if possible, mailbox fallback    │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ attn://review/r_8x4nq2-…#key=A1b2C3d4E5…   [Copy] [QR]    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Verify-key                                                     │
│   SHA-256(owner key) = 8a4f c019 b3d7   [Copy fingerprint]      │
│   (read aloud to reviewer for out-of-band verification)         │
│                                                                 │
│  ☐ I only use one device for review                             │
│     (auto-deletes mailbox events after I acknowledge)           │
│                                                                 │
│                                          [Cancel]   [Start]     │
└─────────────────────────────────────────────────────────────────┘
```

Notes:

- **Mode = radio list, not dropdown.** Mode affects TTL, transport, and what
  the reviewer sees; tradeoffs deserve inline helper text. Segmented control
  loses the help.
- **`longSession`** is implicit in the "Async 7d" radio — no separate
  checkbox. Picking 7d sets `policy.longSession = true` and clamps
  `expiresAt = createdAt + 7d` per amendments #8.
- **Generated URL** uses `attn://review/<roomId>#key=…` per data-model.md
  §771 and amendments' custom-scheme routing. URL is non-editable; Copy is
  primary. QR is v2.1 convenience.
- **Verify-key fingerprint** = `SHA-256(ownerSigningKey)` truncated to **12
  hex chars** per crypto-spec.md §400-402. Grouped `4-4-4` for read-aloud.
  Reviewer's "verify owner" affordance (not in this design) checks the same
  value.
- **Single-device checkbox** controls `deleteEventsAfterOwnerAck` per
  amendments #12. **Unchecked by default** (safer; matches amendment's
  default-false rule). Phrased in user terms, not protocol terms.
- **[Start]** mints the room, copies URL to clipboard, closes dialog; chrome
  flips into review-active state.

**Re-share / inspect existing room:** same dialog opens with URL pre-filled,
mode locked (greyed — v2 does not support mode change post-creation),
[Start] becomes [Done]. A `[End session]` link sits in the dialog
footer's bottom-left.

---

## 7. Peer Strip Representation

Owner + 2 reviewers + 1 agent. Chips are ~28 px tall. Color from existing
CSS vars; **agent shape is what carries the distinction at small sizes.**

```text
┌─ Peer strip (typical) ──────────────────────────────────────────────┐
│  ┌──┐  ┌──┐  ┌──┐  ╭──╮                                             │
│  │J │  │A │  │R │  │⊳ │  +0   [snap @14:02]                         │
│  └──┘  └──┘  └──┘  ╰──╯                                             │
│   ↑     ↑     ↑     ↑                                                │
│  owner  rev   rev   agent                                            │
│  warm   cool  cool  violet (--peer-avatar-bg-{owner|reviewer|agent}) │
│  ●round ●round ●round ◆hex (shape distinguishes agents)              │
└──────────────────────────────────────────────────────────────────────┘
```

Distinctions:

- **Human:** round chip, monogram (first letter of `displayName`). Owner =
  `--peer-avatar-bg-owner`; every other human = `--peer-avatar-bg-reviewer`.
- **Agent:** hexagonal/diamond chip with a `⊳` glyph (a generic agent mark,
  distinguishable from a letter at 20 px). Background =
  `--peer-avatar-bg-agent`. Shape is the primary signal so color-blindness
  and small displays don't lose it.
- **"You":** small `(you)` label under the self chip; no extra color.

Snapshot context — "currently on snapshot X":

- **Hover only**, not always visible. Strip is for presence; per-peer
  snapshot age is detail. Hover popover: `"alex · viewing snapshot @ 13:30
  (owner on 14:02 · 1 behind)"`.
- The aggregate snapshot label (`[snap @14:02]`) renders inline to the right
  of the strip when the active snapshot is the latest. When *this user* is
  on owner's current snapshot, no badge.

Overflow: more than 5 peers → first 4 chips + `+N`. Click `+N` → full list
popover. Click any chip → presence detail popover. No drag, no context
menu in v2.

---

## 8. Recommendation

**Adopt Candidate (b): a dedicated review-bar row** that appears only when
a review session is bound to the active file. Order left-to-right:
`[Share]` (owner-only slot) → connection badge → peer strip → snapshot
label at the right end (the snapshot badge itself is owned by 4.9).

**(b) wins on the four criteria:**

1. **Default-state non-intrusiveness — strongest.** No session = no chrome.
   attn-as-viewer is unchanged. (c) requires a permanent mini-badge; (a)
   either always shows Share or chrome-shifts on session start.
2. **Coherence with 10.1's flat-with-chips panel.** 10.1 names "connection
   badge" and "peer strip header" as panel surfaces (lines 378-379), but
   also states "share button is separate, in the toolbar" (line 392). Under
   (b), the review-bar row owns share + badge + peers, and the panel header
   drops the badge to become `Review · 23 open · 4 sugg   ▼ filter   ⌕   [✕]`
   — counters, filters, close. Per-document chrome lives on the document;
   per-panel chrome stays focused on triage. **10.1's 4.3 implementation
   needs to know about this drop before code lands.**
3. **Narrow-window resilience — best.** The row owns its own single-line
   overflow rules independent of the breadcrumb, keeping the breadcrumb
   readable. (c) puts panel and editor in direct width competition; (a)
   puts breadcrumb and Share/badge in direct width competition.
4. **Keyboard accessibility.** Two new bindings via 12.9's composer hook:
   - `Cmd+Shift+S` — open Share dialog (owner only). Mnemonic; does not
     collide with `Cmd+S` save (we have no save-as).
   - `Cmd+Shift+J` — focus the peer strip (`Tab` traverses chips). Adjacent
     to `Cmd+J` panel toggle so review chrome shares a chord namespace.
   - `Cmd+.` (12.9 composer chord prefix) is **not** claimed here — this
     row does not host composers.

**Specific shape per affordance:**

- **Share button:** rounded pill `[ ↗ Share ]` in the row's left slot,
  owner-only. Triggers §6 modal. Post-mint: `[ ⊜ Sharing ]` with a dot in
  the active mode color (live = `--primary`, mailbox = `--muted-fg`).
- **Connection badge:** 4-state chip per §5. Reuses `--primary` /
  `--muted-foreground` / `--destructive`. Click → detail popover.
- **Peer strip:** chip row per §7. Round chips for humans, hex chips for
  agents. Hover for per-peer detail; click for popover.

---

## 9. Open Questions

1. **Mini-mirror in the main toolbar when the review-bar row is absent —
   keep it out?** Recommendation says no (the row is the mirror). But a
   user who closes a tab and reopens the same file has no indicator that
   another tab is sharing it. Should the TabBar show a 6 px dot on a tab
   whose file has an active room? (Lean: yes — confirm.)
2. **Share confirm step — modal vs inline popover?** §6 picks modal for
   focus capture on a consequential action. Confirm.
3. **Review-bar row at narrow widths — collapse `[Share]` label to icon
   `[↗]` below ~480 px?** §3 candidate (b) narrow mockup does this. Confirm
   icon-only is acceptable, or require always-text-labels for
   accessibility.
4. **Agent chip glyph — Unicode geometric (`⊳`) for v2, swap to SVG bot
   icon in a polish pass?** CLAUDE.md discourages emoji in source; a single
   custom SVG would be cleanest but adds an asset. Decide ship shape.
