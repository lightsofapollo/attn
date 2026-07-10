# Sharing v3 — durable links, notifications, permission tiers, the acceptance gate

Status: proposal for annotation. Follows from the 2026-07-10 gap analysis of
"what's missing for markdown/HTML sharing." Grounded in
`planning/collab/amendments.md` (the 16 locked v2 decisions) — each workstream
below states which decisions it amends and which it deliberately preserves.

## Framing

v2 was designed around **agentic review**: rooms last minutes to an hour, the
link is a session, the owner's file is the source of truth. That framing is
correct and stays. What v2 does not cover is **sharing as a category**: sending
a person a markdown/HTML doc where the link is expected to keep working, the
recipient is expected to be notified of activity, and the sender is expected to
control what the recipient can do.

### Goals

1. **The link is the document.** A share URL keeps resolving for as long as the
   owner wants it to — days, weeks — without the owner babysitting a room.
2. **Collaboration works asynchronously.** Comments left while you're away
   reach you without you thinking to open the app.
3. **The sender controls the verb.** View-only, comment, and suggest links are
   distinct capabilities, enforced as strongly as the E2E model allows.
4. **The owner accepts everything.** No path — human or agent — mutates the
   owner's file except the owner's accept action. This is already the v2
   invariant (owner-only `AcceptSuggestion`, `agent-cli-howto.md` crib sheet);
   this plan elevates it from an implementation fact to a product principle and
   gives agents a first-class way to *block on* it.

### Non-goals

- **Live co-editing.** Explicitly out. The collaboration verb is *suggest*, at
  whatever latency the transport allows (WebRTC makes it feel live). No CRDT,
  no shared cursor authority over the body, no operational transform.
- **Accounts / server-side user database.** Everything below stays inside
  URL-as-bearer + per-participant keypairs. The relay never learns content,
  identity beyond pubkeys, or keys.
- **Knowledge-base features.** Obsidian/vault integration is a separate, thin
  distribution play (a community plugin that shells out to `attn`), not part of
  this plan.

---

## Workstream A — Durable share links

**Problem.** Decision #8 caps rooms at 24h (7d with `longSession`). Correct for
review sessions; fatal for sharing — the mental model people bring from
Docs/HackMD is "the link is the doc, forever." A link that 404s after a week
means attn never becomes anyone's sharing habit.

**Approach: keep rooms ephemeral; add a durable indirection.** Do not stretch
room TTLs to months — rooms carry event logs, cursors, and a 25 MiB cap
(decisions #8–#10) and were never designed to live that long. Instead introduce
a **share**: a small, long-lived relay object that points at the current room
and retains the latest encrypted snapshot between rooms.

### Design sketch

- **Share record** (new DO or KV entry): `shareId`, owner `ownerSigningKey`,
  optional current `roomId`, blob ref to the **latest encrypted snapshot** per
  file, `updatedAt`, `expiresAt`. Owner-signed writes only (same
  `Attn-Owner-Signature` scheme as decision #3). PoW on writes (decision #6).
- **URL form:** `https://attn.sh/s/<shareId>#key=<shareSecret>` (and
  `attn://share/<shareId>#key=...`). The fragment never reaches the relay.
- **Key schedule:** `shareSecret` is the root; per-epoch room secrets derive as
  `roomSecret_n = HKDF(shareSecret, "attn share room v3", epoch_n)`. The same
  URL admits into every successive room of the share without changing. Rooms
  themselves are unchanged v2 rooms — decision #8 TTLs intact.
- **Visitor flow, owner online:** share record has a live `roomId` → join it
  exactly as today.
- **Visitor flow, owner offline / room expired:** fetch the share's latest
  encrypted snapshot → decrypt client-side → render read-only → comments queue
  into a share-scoped mailbox (same envelope format, share-level DO). When the
  owner's daemon next connects it mints a fresh room (next epoch), drains the
  share mailbox into it, and updates the share record. The visitor's browser
  upgrades to the live room when it appears.
- **Lifetime:** share `expiresAt` defaults to 90 days since last owner touch;
  every owner daemon connect renews it. Owner can revoke instantly
  (`DELETE /v3/shares/:shareId`, owner-signed) — revocation kills the pointer
  and the retained snapshot, which is a real kill switch URL-as-bearer rooms
  never had.

### Amendment impact

- **Preserves** #8 (room TTLs), #10 (snapshot eviction within rooms), #2
  (URL-as-bearer admission — extended to shares).
- **Amends** #9: R2 lifecycle needs a share-scoped retention class (snapshot
  blobs pinned by a share outlive the 7-day sweep; owner renewal re-pins).
- **New relay surface:** `POST/GET/DELETE /v3/shares/:shareId` + share mailbox.
  Conformance-corpus additions per the Phase 3a pattern.

### Fallback option (rejected but cheap)

`policy.durable == true` rooms with heartbeat-renewed idle TTL. Fewer moving
parts, but months-long event logs fight the 500-event and 25 MiB caps, stale
cursors multiply, and the URL still dies whenever the room is ever evicted.
The indirection costs one small relay object and keeps every v2 invariant.

---

## Workstream B — Async notification loop

**Problem.** The mailbox durably *delivers* while you're offline; nothing
*tells* you. Sharing is mostly asynchronous — "I left you comments" currently
requires the other side to spontaneously open the app.

Layered, cheapest-first:

1. **In-app unread state.** Per-room unread counts from the import pipeline;
   badges on the peer strip / tab / tree. Pure client work, no protocol change.
2. **Native notifications from the daemon.** The daemon already imports events
   while resident; when a comment/suggestion/verdict imports and the relevant
   room isn't focused, post a macOS user notification (owner *and* reviewer
   side). Click deep-links via the existing `attn://review/...` handler.
   Debounce per room (e.g. collapse to "3 new comments on plan.md").
3. **Resident daemon.** Notifications only fire while the daemon runs, so make
   "attn is running" the normal state: `attn daemon --resident` + optional
   login item (launchd). The daemon already forks and idles cheaply; this is a
   lifecycle/packaging change, not new machinery. Windowless-resident is the
   default once opted in; opening a doc attaches to the same instance as today.
4. **Browser Web Push — first-class, not deferred.** The browser reviewer has
   no daemon to be resident: without push, the browser side of a share is dead
   the moment the tab closes. Since browser recipients are exactly who shares
   are sent to, this is load-bearing for the category, not polish.

### Browser Web Push design sketch

The constraint is the same as everywhere else: the relay stays content-blind.
The trick is that the push itself carries nothing — decryption happens locally
in the service worker using capabilities the browser already holds.

- **Prerequisite:** the room/share is **remembered** (decision #13). Push is
  offered only alongside "Remember this room" — an invite-only session has no
  persisted capability for a service worker to wake up with, by design.
- **Subscribe:** service worker on `attn.sh` registers a Push API
  subscription (relay holds the VAPID keypair). The client POSTs the
  subscription endpoint to the relay bound to `(roomId|shareId, deviceId)`,
  MAC'd with the admission key and PoW'd like every other write (decision #6).
  Subscriptions expire with the room/share TTL; share renewal (Workstream A)
  re-pins them. The share record grows a `pushSubscriptions` field.
- **Notify:** on envelope arrival for a device with a subscription and no live
  WS connection, the relay sends a **content-free ping** — no body, or at most
  the opaque roomId it's already keyed by. No author, no event kind, no text
  ever transits push infrastructure (Apple/Google relays see nothing).
- **Wake and decrypt locally:** the ping wakes the service worker; it opens the
  remembered-room capability from IndexedDB, pulls pending envelopes over WS,
  decrypts + verifies locally, and shows a *locally-composed* rich notification
  ("2 new comments on plan.md"). Click focuses/opens the room. Debounce
  server-side per device (collapse bursts into one ping).
- **iOS Safari caveat:** Web Push on iOS requires the site installed to the
  Home Screen as a PWA (16.4+). This rides the attn-7xl iOS work
  (`planning/web-authoring/05-ios-offline.md`) — the install prompt and the
  push opt-in are the same UX moment. Desktop browsers have no such gate.
- **Native side unchanged:** the daemon keeps its WS mailbox connection;
  push is a browser-client concern. (APNs for a future native-mac cold-start
  story stays out of scope.)

Layer 1 covers reviewer-in-browser on reopen via remembered rooms; layer 4 is
what makes the browser side *proactive* and closes the async loop for the
no-install audience.

---

## Workstream C — Permission-tiered links

**Problem.** Decision #2 makes URL possession = full participation. Fine for
inviting a trusted peer or an agent; wrong the first time someone shares
outward (a client, a mailing list, a public link). Sharing needs at least
view / comment / suggest tiers.

**Approach: capability = which keys the URL carries.** Split the HKDF tree so
read and write are separate capabilities; the relay enforces the read/write
boundary, and the owner's import pipeline enforces the comment/suggest
boundary.

### Design sketch

- **Key split.** From `roomSecret` (or `shareSecret`) derive:
  - `readKeys` — event/snapshot decryption + a read-admission MAC key
    (WS connect, blob GET).
  - `writeAdmissionKey` — MACs mutating requests (`POST /devices`,
    `/envelopes`, `/acks`, `/blobs`), separate HKDF info string.
  A **view-only URL** simply omits the write capability from its fragment. The
  relay rejects writes that don't MAC with `writeAdmissionKey` — cryptographic
  enforcement, no server state, decision #2's shape preserved (two bearer
  capabilities instead of one).
- **Comment vs suggest.** Envelopes are opaque to the relay, so this boundary
  cannot be relay-enforced. Bind a `grantTier` (`comment` | `suggest`) into the
  device-registration payload (signed, AAD-bound); the owner client and peers
  drop out-of-tier events on import and the composer UI simply doesn't offer
  suggest to comment-tier participants. Policy enforcement, honestly
  documented as such in the trust model — a hostile comment-tier client can
  emit a suggestion envelope, and every conformant client discards it.
- **Owner tier unchanged** — decision #3's `ownerSigningKey` remains the only
  accept/apply/admin authority.
- **Share sheet UI.** "Anyone with this link can: view / comment / suggest" —
  three copyable URLs per share. Default **comment** for human invites,
  **suggest** for agent invites (agents exist to propose changes).
- **Rotation.** Because tiers are derived keys, revoking a leaked view link
  without disturbing suggest-tier participants means rotating the read branch —
  practically: bump the share epoch (Workstream A) and re-issue. Cheap once
  shares exist; document as the supported revocation story.

### Amendment impact

- **Amends** #2 (one admission key → read/write capability pair; still
  URL-as-bearer, still no server-side token state).
- **Touches** crypto-spec key-derivation tree (new info strings, v3-suffixed),
  relay-spec per-endpoint auth table, device-registration schema (`grantTier`).
- **Sequencing note:** ship C **before** A is promoted publicly — a durable
  link whose only form is full-power is exactly the artifact you don't want
  circulating for 90 days.

---

## Workstream D — The acceptance gate (agents in worktrees)

**Problem.** The invariant "only the owner's accept mutates the file" already
holds (`AcceptSuggestion` is owner-only; agents submit, humans decide). What's
missing is the *workflow* built on it: an agent that does a chunk of work,
proposes it, and **cannot continue until the author has ruled on every
change**.

### Design sketch

- **Convention: agents work in worktrees.** The agent's edits live in its own
  git worktree; nothing it does touches the owner's working copy. What crosses
  the boundary is suggestions in the review room. On accept, the owner-side
  apply flow (Phase 5, shipped) writes the owner's file; the agent then
  reconciles its worktree from the verdicts and proceeds. The worktree is the
  staging area; the room is the approval queue; the owner's file is the truth.
- **New CLI: `attn review verdicts`.**
  - `attn review verdicts --json` — dump current verdict state for the room's
    suggestions (`pending | accepted | rejected`, with `resulting_hash` for
    accepted ones, from the existing `SuggestionAccepted`/`SuggestionRejected`
    envelopes).
  - `attn review verdicts --wait [--for <id>,<id>...] [--timeout <dur>]` —
    block until every listed (default: all own pending) suggestion has a
    verdict; exit 0 with the JSON verdict map, non-zero on timeout. This is the
    gate: the agent's loop is `submit-suggestion* → verdicts --wait → branch on
    accepted/rejected`.
  - Wait on a condition, not a poll loop — the daemon (or agent-CLI transport)
    already receives verdict envelopes push-fashion over WS/DataChannel;
    `--wait` parks on that stream.
- **Convenience: `attn review submit-suggestion --from-diff`.** Turn a unified
  diff (i.e. the agent's worktree changes to the shared doc) into one
  suggestion per hunk, anchored via the existing anchor engine. Removes the
  main friction in "agent worked in a worktree, now propose it."
- **Partial acceptance is the point.** The author accepts some hunks, rejects
  others; the agent regenerates from what survived. Nothing continues on an
  unresolved queue — that's the contract.

### Amendment impact

None — builds entirely on shipped surfaces (agent identities, suggestion
envelopes, owner apply flow, verdict events). This is the smallest workstream
and the one that most directly serves the agentic-collab framing.

---

## Sequencing

| Order | Workstream | Why this position |
|---|---|---|
| 1 | **D — acceptance gate** | Smallest; no protocol change; completes the agent story v2 was framed around. Parallelizable with everything. |
| 2 | **C — permission tiers** | Protocol/crypto change; must precede public durable links. |
| 3 | **A — durable shares** | The category-defining piece; depends on C for safe outward links. |
| 4 | **B1/B2 — unread + native notifications** | Client-side; can interleave anytime. B3 (resident daemon) rides the packaging train. |
| 5 | **B4 — browser Web Push** | First-class: the browser audience has no resident daemon, so push closes the async loop for exactly the people shares are sent to. Depends on remembered rooms (shipped) + relay subscription store; land alongside A so shares ship with push, not after it. iOS variant rides attn-7xl's PWA work. |

Interaction with **attn-7xl (browser workspaces)**: independent — A's
"read while owner offline" uses the already-shipped browser snapshot renderer.
Where they meet (browser-owned rooms wanting durable shares too), the share
record is owner-key-agnostic and works for a browser owner unchanged.

## Open questions (annotate here)

1. A: is 90-day owner-renewed share expiry the right default, or should shares
   be explicitly immortal-until-revoked?
2. C: default tier for human invites — comment or suggest?
3. B3: is resident-daemon opt-in (login item checkbox) or the default install
   behavior?
4. D: should `--from-diff` granularity be per-hunk (proposed) or per-file?
5. A: does the retained latest-snapshot-per-file cover folder shares fully, or
   do we cap durable shares at N files initially?
6. B4: is push opt-in bundled into "Remember this room" as one consent, or a
   separate second toggle? (One consent is less friction; two is more honest
   about what's being granted.)
