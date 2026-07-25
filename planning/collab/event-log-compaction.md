# Event-log compaction: late joins without replaying the world

Status: step compaction is implemented. On 2026-07-25 cursor/view presence was
moved off the relay data plane entirely and onto a dedicated lossy WebRTC
DataChannel, prompted by hitting `ATTN_ROOM_EVENT_CAP` (500) in a live session.

## Implemented presence lane

V3 cursor/view updates remain signed `signalClass: "presence"` envelopes so the
receiving peer can authenticate their registered device, but clients send them
only over the `attn-presence` WebRTC DataChannel. That channel is unordered and
uses `maxRetransmits = 0`; if a peer has no direct path, the sample is dropped.
Clients expire a remote cursor/location after five seconds without a newer
sample and refresh stationary presence every two seconds. The relay's
latest-state implementation remains as mixed-version
compatibility handling, but current clients do not upload presence to it.
Document steps, review events, snapshots, WebRTC negotiation, and roster
membership retain their existing transport and durability rules.

## The insight: we already merge pending edits

The owner's debounced snapshot republish IS the merge James is asking
about. Every epoch snapshot is the fully-merged document at a point in
the log. A late joiner therefore only genuinely needs:

1. the **latest snapshot** (merged document) — exists today;
2. the **durable review events** — comments, suggestions, resolutions,
   participant joins — the actual review history;
3. the **collab steps after that snapshot** — a few seconds' worth.

What they get instead is a replay from seq 0: every collab step ever
sent, each one superseded by the snapshot that followed it. Steps are
~90% of a busy room's log. They are pure waste for a late joiner AND
they're what eats the 500-event cap.

The wire contract already anticipates trimming: `cursor_too_old`
(WS close 4005) exists precisely so a client whose cursor points into a
pruned range re-bootstraps from the snapshot. Client handling is wired.
Nothing today ever actually prunes.

## Constraint: the relay can't tell steps from comments

Envelopes are E2E-sealed; the relay sees `kind: event` for both a
keystroke step and a comment. Selective pruning therefore needs a
client-declared, cleartext distinction. This leaks "which envelopes are
keystrokes vs comments" — but frequency/size analysis already leaks
exactly that (steps are small and bursty), so the marginal metadata cost
is ~nil.

## Proposal

**1. A cleartext `ephemeral` class on step envelopes.** Collab steps go
out as `kind: "event", class: "step"` (or `ephemeral: true`). Comments,
suggestions, resolutions, participant events stay durable. One field on
the envelope header, set by both clients.

**2. Owner-driven compaction floor.** The owner's `SnapshotCreated`
publish carries `compactStepsBefore: <serverSeq of the snapshot>`
(authenticated by the same write capability + owner signature that
already gates snapshot publish). On receipt the relay deletes ephemeral
envelopes with `serverSeq < floor` and decrements the room's running
count/bytes accordingly. Durable events are NEVER pruned — the cap then
bounds real review history only, which is legitimate backpressure.

**3. Joiner bootstrap stays as-is.** Fresh joins subscribe from seq 0
and now replay only durable events + live steps. Reconnecting clients
whose cursor predates the floor get `cursor_too_old` → existing re-seed
path.

**4. Cap raised modestly, not infinitely.** With steps compacted, the
count measures comments + snapshots pointers. 500 is plausibly fine;
2,000 gives headroom for marathon review sessions without inviting
abuse. (The 25 MiB room byte cap independently bounds storage either
way.)

## Why not alternatives

- **Raise the cap alone** (the quick fix, staged in wrangler.toml as
  500 → 10,000): buys runway, fixes nothing structural — a long session
  still fills any number, and late joiners still replay every stale
  step. Fine as an interim, wrong as the answer.
- **Per-envelope TTL on steps** (steps expire after ~10min): simpler
  protocol-wise, but the relay currently has no envelope-expiry sweep at
  all, and a fixed TTL races long owner offline gaps — a snapshot-keyed
  floor is precise and never prunes a step that is still the newest
  content.
- **Client-side merge on join** (download everything, apply fast):
  solves CPU, not bandwidth/storage/cap. No.
- **Fold comments into snapshots** so even durable events compact:
  the real endgame (a joiner would need exactly ONE snapshot + tail),
  but it moves thread state into the document snapshot format — a
  cross-client wire change like the compression cutover. Phase 2.

## Work plan (if approved)

1. Envelope schema: cleartext `class` field, both clients + relay
   validation (relay: schema.ts; native: envelope.rs; web:
   browser-envelope.ts). Conformance vectors.
2. Relay: compaction on snapshot publish with owner-sig gating;
   count/byte accounting decrement; regression tests (cap recovery
   after compaction; cursor_too_old on pruned range).
3. Clients: tag steps as ephemeral; owner sends the floor with each
   snapshot publish.
4. Revert the interim 10,000 cap to ~2,000.

Estimate: ~1.5 days across relay + both clients, mostly tests. All
three pieces ship together (relay tolerates untagged envelopes as
durable, so old clients stay correct during rollout — no forced
lockstep).
