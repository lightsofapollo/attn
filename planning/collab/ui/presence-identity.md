# Reviewer + Agent Identity and Presence

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.5).
Blocks: attn-nnj.4.12 (peer strip), attn-nnj.4.9 (snapshot badge + status row).

References:

- `planning/collab/ui/connection-share.md` (10.3) §7 — peer-strip chip shapes
  and color tokens. This doc is the deeper read of "what one chip stands for"
  and how that chip's bearer is identified and trusted.
- `planning/collab/ui/review-panel-design.md` (10.1) §1.2 — margin sticky-card
  anatomy. The author chip lives in the card header; this doc specifies what
  goes inside it.
- `planning/collab/ui/three-way-apply.md` (10.4) — snapshot-mismatch surfaces;
  this doc owns the *per-peer* "on a different snapshot" badge.
- `planning/collab/data-model.md` §Terms (lines 138-171) — `Participant`,
  `Device`, `ParticipantId`. A participant has many devices; identity is
  per-participant, presence is per-device.
- `planning/collab/amendments.md` Decision #1 — agentic collaboration is the
  primary use case. Agents must be first-class in the visual hierarchy.
- `planning/collab/crypto-spec.md` §Out-of-Band Verification (line 400)
  + §Signing-Key Publication (lines 213-221) — fingerprint is
  `SHA-256(publicSigningKey)` truncated to 12 hex chars; `signingKeyId`
  is base64url of the same SHA-256.
- `web/src/app.css` lines 76-83 / 156-163 — `--peer-avatar-bg-{owner,
  reviewer,agent}` exist. **Do not invent new identity colors.**

---

## 1. Identity Model

What we know about each participant on the wire, per `data-model.md`:

```ts
type Participant = {
  participantId: ParticipantId;     // opaque, stable per room
  displayName: string;              // self-chosen, not unique
  kind: "owner" | "reviewer" | "agent";
  publicSigningKey: string;         // long-form Ed25519 public key
  capabilities: Capability[];
};

type Device = {
  deviceId: DeviceId;               // 1..N per participant
  participantId: ParticipantId;
  publicSigningKey: string;         // distinct per device
  publicEncryptionKey: string;
  client: "attn-native" | "attn-browser" | "agent-cli";
  createdAt: number;
};
```

Derived, displayed values:

- `signingKeyId` — `base64url(SHA-256(publicSigningKey))` per crypto-spec
  §213. Stable per device. Displayed truncated.
- `fingerprint12` — `hex(SHA-256(publicSigningKey)).slice(0, 12)` per
  crypto-spec §400. Displayed grouped `4-4-4` for read-aloud. Used for the
  owner's out-of-band verification only.
- `tail6` — last 6 hex chars of the same SHA-256, cheap hover-disambig (§3).

Identity rules used throughout this doc:

1. `participantId` is the stable identity. Two chips share an identity iff
   they share `participantId`.
2. `displayName` is **untrusted, self-chosen, not unique** — two reviewers
   can both call themselves "alex". The fingerprint disambiguates.
3. `kind` is set at join: non-owner URL holders join as `reviewer`; `agent`
   is asserted by the joining client and tagged in the participant record.
4. Owner's `kind` is verified cryptographically (the `ownerSigningKey`
   was published at room-creation; reviewers cannot impersonate). The
   reviewer-vs-agent split is a self-declared label — see §7.

---

## 2. Visual Identity per Kind

Per 10.3 §7, chip shape carries the human-vs-agent distinction so it
survives small sizes and color-blindness. This doc reuses those shapes and
locks the rendering rules.

```text
┌─ Chip taxonomy ────────────────────────────────────────────────────┐
│                                                                    │
│   owner          reviewer        agent                             │
│   ┌────┐         ┌────┐          ╭────╮                            │
│   │ J  │         │ A  │          │ ⊳  │                            │
│   └────┘         └────┘          ╰────╯                            │
│   round          round           hex/diamond                       │
│   monogram       monogram        glyph (not a letter)              │
│   --peer-avatar  --peer-avatar   --peer-avatar-bg-agent            │
│     -bg-owner     -bg-reviewer   (violet)                          │
│   (warm)         (cool)                                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Rules:

- **Monogram = first grapheme cluster of `displayName`**, uppercased. Falls
  back to `?` if `displayName` is empty.
- **Agent glyph is `⊳`** (Unicode `U+22B3`, normal subgroup of). Chosen for
  v2 because it is geometric, monospace-friendly, has no semantic baggage,
  and renders cleanly at 16 px. See open question 4 for the SVG-swap path.
- **Agents never carry a monogram.** Different agents differ by chip color
  shade (§7) and label, not initial. A literal "R" on a hex chip would
  read as "another human" at a glance.
- **Owner color is the warm slot, reviewer is the cool slot, agent is
  violet** — exactly the three vars in `app.css`. No new tokens.
- **Self (the user viewing the UI) gets no color change** — only the
  `(you)` label (§7). The same identity rendered on someone else's screen
  must look identical, so a "self tint" would diverge two views.

### 2.1 Multi-device — single chip with badge

A participant on N devices renders as **one chip with a small "×N" badge**
at the bottom-right corner. Recommendation: stack-of-chips is rejected as
visually heavier and ambiguous (looks like N participants).

```text
┌─ Multi-device chip (alex on 2 devices) ────────────────────────────┐
│   ┌────┐                                                           │
│   │ A  │·2                                                         │
│   └────┘                                                           │
│       ↑ device count, only when > 1                                │
└────────────────────────────────────────────────────────────────────┘
```

Tooltip / expand behavior:

```text
┌── alex · 2 devices ──────────────────────────────┐
│ ● alex (laptop)     viewing 2 min ago            │
│ ◐ alex (phone)      last seen 14 min ago         │
│ fingerprint: 8a4f c019 b3d7                      │
└──────────────────────────────────────────────────┘
```

Presence aggregation: the chip-level dot reflects the **most-recently-active
device** (most-online wins). If any device is currently viewing, the chip
shows the green dot. The popover lists per-device truth.

---

## 3. Per-Comment Identity (margin card header)

Per 10.1 §1.2 the margin card header is the canonical author chip. This
section locks its content.

```text
┌─ Card header (comment by alex, 3m ago) ────────────────────────────┐
│ ┌──┐                                                               │
│ │A │ alex · 3m         comment ◧                                   │
│ └──┘                                                               │
│  ↑     ↑     ↑          ↑       ↑                                  │
│  chip  name  rel-age    kind    overflow                           │
└────────────────────────────────────────────────────────────────────┘

┌─ Card header (suggestion by agent rufus, 1h ago, stale) ───────────┐
│ ╭──╮                                                               │
│ │⊳ │ rufus [agent] · 1h    suggest ▲ ◧                             │
│ ╰──╯                                                               │
└────────────────────────────────────────────────────────────────────┘
```

Rules:

- **Avatar chip on the left**, 20 px, same shape rules as §2.
- **`displayName`** in normal weight.
- **`[agent]` suffix** is **always visible** for agent authors, not
  "first-appearance-only". Reasoning: cards are read out of order (jumping
  via filter, anchor, or thread expand) so "first appearance per session"
  is unreliable. The suffix is short and the cognitive cost of seeing it
  twice is far less than the cost of mistaking an agent for a human once.
  No separate bot icon — the chip shape already carries that signal; the
  word "agent" is the unambiguous reinforcement.
- **Relative age** ("3m", "1h", "2d") per 10.1's recommendation, with the
  full ISO timestamp surfaced via `title=` attribute (hover/tooltip). Rolls
  over to absolute date after 30 days.
- **On hover the chip area**, a small popover surfaces the disambiguator:

  ```text
  ┌──────────────────────────────────────┐
  │ alex · reviewer                      │
  │ fingerprint tail: …b3d7              │
  │ (click for identity card)            │
  └──────────────────────────────────────┘
  ```

  Tail-6 is the *cheap* disambiguator — enough to tell two "alex" chips
  apart in a thread without reading aloud the full fingerprint.

---

## 4. Presence Indicators

Per-device presence renders as a status dot pinned to the chip's
bottom-right (mirrored from the device-count badge slot; only one occupies
the slot at a time — see §6 for the resolution rule).

```text
┌─ Presence states ──────────────────────────────────────────────────┐
│                                                                    │
│   ┌────┐●     currently viewing this document                      │
│   │ A  │      green dot · --primary                                │
│   └────┘                                                           │
│                                                                    │
│   ┌────┐◐     last seen 14 min ago (idle)                          │
│   │ A  │      grey dot · --muted-foreground                        │
│   └────┘                                                           │
│                                                                    │
│   ┌────┐▲     on a different snapshot than mine                    │
│   │ A  │      small warning triangle · --warning (or warm accent)  │
│   └────┘                                                           │
│                                                                    │
│   ┌────┐      disconnected — entire chip drops to 50% opacity      │
│   │ A  │      no dot; opacity carries the signal                   │
│   └────┘                                                           │
│   (dim)                                                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Specifics:

- **"Currently viewing"** = a `PresencePing` (or equivalent presence event)
  within the last 30 s. Tunable later.
- **"Last seen X min ago"** uses the same relative-age format as §3.
  Surfaced inline via popover (`click chip`) and as `title=` on hover.
- **"On a different snapshot"** triangle is **per-peer** and renders only
  when *this* peer is on `snapshotId ≠ ownerCurrentSnapshotId`. The
  document-level "you are on a different snapshot than owner" banner is
  4.9's territory — those are different surfaces and must not duplicate.
- **"Disconnected"** is the strongest visual state (50% opacity on the
  whole chip). Stacks with the triangle: a disconnected reviewer who was
  last seen on an older snapshot dims *and* shows the triangle.

Status-slot precedence when multiple signals apply to a single device:
disconnected > snapshot-mismatch > viewing > idle. (Disconnected = opacity
change; snapshot-mismatch = triangle; viewing/idle = colored dot. Only one
visual element occupies the dot slot.)

---

## 5. Trust Affordances

Per crypto-spec §400, the UI must expose the owner's fingerprint for
out-of-band verification. This is the identity card.

### 5.1 Identity card (click any chip)

```text
┌── Identity ──────────────────────────────────────────────┐
│                                                          │
│   ┌────┐                                                 │
│   │ J  │   james    [owner]                              │
│   └────┘                                                 │
│                                                          │
│   Fingerprint  8a4f c019 b3d7                            │
│   participantId  p_2nq8x4-…  [copy]                      │
│   signingKeyId   k_9d4e1f2a   [copy]                     │
│                                                          │
│   Devices                                                │
│    ● laptop  (attn-native)  joined 14:02                 │
│    ◐ phone   (attn-native)  last seen 14 min ago         │
│                                                          │
│   [✓ Verify owner key]                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- Always-visible: `displayName`, kind badge, fingerprint (grouped 4-4-4),
  `participantId` (truncated, copyable), `signingKeyId` (truncated,
  copyable), device list.
- **Verify-owner affordance** is only present on the owner's card and only
  when viewed by a non-owner (the owner cannot verify their own key
  against themselves).

### 5.2 Verify-owner flow (reviewer-side)

```text
┌── Verify owner key ──────────────────────────────────────┐
│                                                          │
│   Ask james to read aloud their fingerprint              │
│   (Share dialog → Verify-key field on their side).       │
│                                                          │
│   Enter the 12-character fingerprint they read:          │
│   ┌──────────────────────────────────────────────────┐   │
│   │ 8a4f c019 b3d7                                   │   │
│   └──────────────────────────────────────────────────┘   │
│   (spaces and case ignored)                              │
│                                                          │
│            [Cancel]              [Verify]                │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Result states:

```text
┌── ✓ Match ───────────────────────────────────────────────┐
│ Owner key verified. The identity card now shows a check  │
│ next to james's fingerprint for the rest of this room.   │
└──────────────────────────────────────────────────────────┘

┌── ✗ Mismatch — STOP ─────────────────────────────────────┐
│ The fingerprint james read does NOT match the key in     │
│ this room. Possible causes:                              │
│   • You joined a room minted by someone other than james │
│   • Someone intercepted the share URL                    │
│                                                          │
│ Do not trust further events. Leave the room and ask      │
│ james for a fresh URL over a known-good channel.         │
│                                                          │
│   [Leave room]   [Dismiss]                               │
└──────────────────────────────────────────────────────────┘
```

Mismatch is treated as a hard event — no soft "warning toast that you can
ignore." The whole point of the OOB check is to be loud on failure.
`Dismiss` exists for the case where the *user* misread the fingerprint
(operator error); they can re-verify. The chip in the peer strip carries
a small `⚠` decoration after a mismatch until either (a) a successful
re-verify or (b) leaving the room. Successful verification adds a small
`✓` decoration to the owner chip — persistent for the room's lifetime,
stored only in local UI state.

---

## 6. Multi-Device Handling — Detail

The chip badge slot at bottom-right is shared between *device-count* and
*presence-dot*. Resolution:

```text
┌─ Single device, viewing      ┌─ Two devices, one viewing
│   ┌────┐●                    │   ┌────┐●·2
│   │ A  │                     │   │ A  │
│   └────┘                     │   └────┘
│   green dot only             │   green dot AND count badge stacked

┌─ Two devices, all idle       ┌─ Two devices, one disconnected
│   ┌────┐◐·2                  │   ┌────┐·1
│   │ A  │                     │   │ A  │  (50% opacity)
│   └────┘                     │   └────┘
│   grey dot AND count         │   dim chip + count "1" (active devices)
```

Rules:

- Count badge always shows **active devices** (connected at all, even if
  idle). A wholly-disconnected participant's count badge reads `0` and the
  chip is dimmed; this is rare (the participant would normally fall off
  the strip when their last device disconnects — see §8 open question 3).
- Stacked rendering (dot + count) reads "[presence][·count]" sharing the
  bottom-right corner. The count is small (8 px) and renders to the right
  of the dot.
- Click chip → identity card (§5.1) lists per-device presence individually.

---

## 7. Agent Attribution — Local vs Remote

Per Decision #1, agents are the primary participant. They split into:

- **Local CLI agent** — `attn review --as-agent rufus` run on the owner's
  own machine (or trusted infra) by the owner themselves. Trust profile:
  effectively co-owner; the owner already trusts the binary and the host.
- **Remote agent** — joined via the same URL as any reviewer, but
  self-declared `kind: agent`. Trust profile: same as any reviewer (the
  URL is a bearer credential; the `kind` is a label).

Recommendation: **surface the distinction explicitly** because the trust
profile differs, and the user's reasonable response to "an agent suggests
deleting your test suite" depends on whether it's the lint-bot they
spawned locally or a remote agent that joined via a URL someone forwarded.

### 7.1 Corner decoration on the chip

```text
┌─ Agent kinds ──────────────────────────────────────────────────────┐
│                                                                    │
│   ╭────╮⌘     local CLI agent                                      │
│   │ ⊳  │     small ⌘ in top-left corner                            │
│   ╰────╯     (host-local; spawned on owner's box)                  │
│                                                                    │
│   ╭────╮◯    remote agent                                          │
│   │ ⊳  │     small ◯ (globe) in top-left corner                    │
│   ╰────╯     (joined via URL; off-box trust profile)               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- **Local** = `Device.client == "agent-cli"` AND the device's joining
  origin was the local relay-loopback (a signal the daemon can stamp at
  join time). Defaulting to "remote" on any ambiguity is the safe call.
- **Remote** = everything else with `Device.client == "agent-cli"`.
- The decoration is **a corner mark, not a separate row** — keeps the
  chip strip dense. Hover/identity-card surfaces the full origin string.
- Human chips (owner/reviewer) carry no corner mark — that slot is
  agent-only. Owner is unambiguous (verified by signing key), reviewer is
  by definition remote.

### 7.2 Per-comment surfacing

In the margin card header (§3), the `[agent]` suffix extends:

```text
│ │⊳ │ rufus [agent · local] · 3m    suggest    │
│ │⊳ │ webhook [agent · remote] · 1h  suggest   │
```

Verbose, but the design's bias is **explicit over clever** for a primary
participant kind with a weaker trust profile than its appearance suggests.

---

## 8. Open Questions

1. **"You" beyond the `(you)` label** — should the self chip have a thin
   2 px border (instead of, or in addition to, the underline label)?
   Lean: yes — the label disappears at narrow widths where chips collapse
   to icon-only. A border is robust to that collapse and reads "this is
   me" without taking a slot.

2. **Color-blindness contingency** — owner (warm) vs reviewer (cool) vs
   agent (violet) is a three-way hue split that does *not* survive
   protanopia and is marginal under deuteranopia. Shape (round vs hex)
   carries the human/agent split, but owner/reviewer is hue-only. Options:
   add a 2 px ring color, add a corner pattern (dots vs stripes), or
   accept that owner has a `[owner]` text badge whenever the chip is large
   enough to fit it. Lean: text badge for owner — semantic, accessible,
   no new visual language.

3. **Mid-room signing-key change** — crypto-spec rejects mid-room key
   rotation at the protocol level. But a device that genuinely lost its
   key and re-joined would appear as a *new* device on the same
   `participantId`. How does the UI surface "alex's laptop has a new key
   since you last verified"? Lean: the per-device row in the identity
   card flags `(new key)` next to a device whose `signingKeyId` differs
   from the last one we saw, and the verify-owner check (if previously
   ✓-passed) drops back to "unverified" until the user re-verifies. No
   forced modal; let the user decide.

4. **Agent glyph asset** — Unicode `⊳` (U+22B3) for v2 vs a custom SVG
   bot icon in a polish pass. CLAUDE.md discourages emoji in source.
   `⊳` is geometric (not emoji), one codepoint, font-rendered, free.
   A custom SVG would be more on-brand but adds an asset, a sizing
   ruleset, and a dark-mode variant. Lean: ship with `⊳`, file a polish
   issue for an SVG swap aligned with the eventual product mark.
