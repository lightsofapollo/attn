# Agent CLI How-To

Status: implementation reference — pins the agent CLI surface to the
amendments and what's shipping today (attn-nnj.9.6 + 9.7).

References:

- `planning/collab/amendments.md` §Agent CLI key handling — the canonical
  three bullets that this doc operationalizes.
- `planning/collab/data-model.md` §Agent UI/CLI (lines 803-814) +
  §Participant And Device (lines 138-171) — the wire shape an agent
  participant takes.
- `planning/collab/relay-spec.md` §`POST /v2/rooms/:roomId/devices` —
  accepted `kind` values include `"agent"`; the relay's
  `deviceRegistrationSchema` validates the enum.
- `planning/collab/ui/presence-identity.md` (10.5) §2 — agents render with
  a hex chip + `⊳` glyph, not a monogram. Driven by `device.kind ==
  "agent"` on the peer-strip.
- `src/review/agent_identity.rs` — on-disk registry.
- `src/review/bootstrap.rs` (`Bootstrapper::join_as_agent`) — join path.
- `src/cli_review.rs` — the CLI shim.

---

## Mental Model

An agent is a **first-class participant** with its own Ed25519 keypair.
Three kinds of agents are supported by the same wire shape:

1. **Local agent on the owner's machine.** A small helper that drives
   `attn review submit-comment` from a shell pipe. Uses an identity
   under `$ATTN_HOME/agents/<name>/`. The amendments call this the
   `--as-agent <name>` flow.
2. **Remote-CI bot.** Runs on a different machine (GitHub Actions,
   Jenkins, etc.). Same wire shape as (1) — registers an agent identity
   on the runner, joins via the invite URL, submits findings, exits.
   The relay can't tell (1) and (2) apart; both POST
   `/v2/rooms/:roomId/devices` with `kind: "agent"`, `client:
   "agent-cli"`.
3. **Hosted assistant (e.g. a Claude-style sidecar).** Lives behind an
   HTTPS API but speaks the same agent CLI under the hood. Indistin-
   guishable from (2) on the wire.

**Why the same shape?** The peer strip + presence UI (10.5) consults
`device.kind == "agent"` to render the hex chip + `⊳` glyph distinction.
Anything that joins as `kind=agent` renders that way; nothing else does.

---

## Lifecycle

```
register-agent  -->  invite URL  -->  join  -->  submit findings  -->  exit
   (once)            (per room)       (per room)    (many)
```

`register-agent` is a one-time setup step that mints the keypair. The
keypair persists across `join`s; the invite URL is the per-room piece.

### 1. Register

```bash
attn review register-agent rufus
# registered agent "rufus"
#   identity:   ~/.attn/agents/rufus/identity.json
#   deviceId:   EA4920D75eJX8wkZvzI_gQ
#   participant:6EbBEmD2AEtrm7aI6LVj5A
#   pubkey:     0EiddaHvvkQ2Vqe1CmvpgXnOB4-O-jCm4ffi7cn3MU4
```

The on-disk file uses the same `DeviceIdentity` shape as the daemon's
`~/.attn/identity.json` — so a future "migrate the daemon to be an
agent" flow doesn't need a schema dance. Re-running `register-agent`
on a name that already exists is rejected on purpose: a stray re-mint
would rotate the agent's pubkey out from under the relay's device
directory.

### 2. Join a room

The room owner emits an invite like
`attn://review/<roomId>#key=<base64url>`. The agent joins:

```bash
attn review join 'attn://review/abc123#key=AAAA' --as-agent rufus
# joined room as agent "rufus"
#   roomId:     abc123
#   deviceId:   EA4920D75eJX8wkZvzI_gQ
#   participant:6EbBEmD2AEtrm7aI6LVj5A
```

Under the hood this:

1. Parses the invite (`Bootstrapper::join_as_agent`).
2. POSTs `/v2/rooms/:roomId` (idempotent — succeeds on a live room).
3. POSTs `/v2/rooms/:roomId/devices` with `kind: "agent"`, `client:
   "agent-cli"`, the agent's pubkey, and a `selfSignature` signed by
   the agent's Ed25519 key.
4. GETs the device directory to seed the verifying-key cache.
5. Signs + enqueues a `ParticipantJoined` event whose
   `participant.kind == "agent"`, so peer-strip clients render the hex
   chip distinction (10.5).

### 3. Submit findings

After 9.7 lands, the same identity is used to sign comments and
suggestions:

```bash
attn review submit-comment comment.json --as-agent rufus
attn review submit-suggestion suggestion.json --as-agent rufus
attn review inbox --json
```

The `--as-agent <name>` flag is the only thing that switches the
signing key from "daemon owner" to "named agent." Without it, findings
are attributed to the local owner (so a small one-shot pipe doesn't
have to register an agent for trivial cases).

### 4. Exit

There's no `unregister` — leaving a room is implicit (the relay TTL
clears the room; the per-agent identity is preserved for the next
join). Removing an agent locally is a `rm -rf $ATTN_HOME/agents/<name>`.

---

## Use-Case Examples

### Local agent (Claude-driven feedback pipe)

```bash
# One-time
attn review register-agent claude

# Per room — invite arrives via Slack/email
attn review join "$INVITE" --as-agent claude
echo '{"body": "L42 has an off-by-one"}' \
  | attn review submit-comment - --as-agent claude
```

### Remote CI bot (GitHub Action)

```yaml
- name: Lint the design doc as an agent
  env:
    ATTN_HOME: ${{ runner.temp }}/attn
    ATTN_RELAY_URL: https://relay.attn.dev
  run: |
    curl -fsSL https://attn.dev/install.sh | sh
    attn review register-agent ci-bot
    attn review join "$INVITE_URL" --as-agent ci-bot
    cargo run --bin lint-design \
      | attn review submit-comment - --as-agent ci-bot
```

Note the per-runner `ATTN_HOME` — each CI run gets a fresh keypair.
That's fine: the relay treats a new pubkey as a new device, and the
room's policy decides whether the join is allowed (`allowRemoteAgents`
must be true).

### Hosted assistant (multi-agent)

A single hosted backend can sign for multiple agent personas by
registering them under disjoint `--as-agent <name>` values:

```bash
# Backend startup
attn review register-agent assistant-research || true
attn review register-agent assistant-style    || true

# Per request, the backend picks the persona by name
attn review join "$INVITE" --as-agent assistant-research
attn review submit-comment - --as-agent assistant-research < findings.json
```

Each persona has its own pubkey and renders as a distinct chip — the
peer-strip never collapses two agents into one even when they share a
backend.

---

## Identity File Format

`~/.attn/agents/<name>/identity.json` — same shape as the daemon's
`~/.attn/identity.json`:

```json
{
  "deviceId": "EA4920D75eJX8wkZvzI_gQ",
  "participantId": "6EbBEmD2AEtrm7aI6LVj5A",
  "signingKey": "<base64url 32-byte Ed25519 seed>",
  "publicSigningKey": "0EiddaHvvkQ2Vqe1CmvpgXnOB4-O-jCm4ffi7cn3MU4",
  "publicEncryptionKey": "<base64url X25519 public>"
}
```

The seed never leaves disk. Back it up if the agent's findings need to
remain attributable across machine moves; otherwise treat it as
disposable and re-register.

---

## Wire-Shape Crib Sheet

| Surface              | Reviewer        | Agent          |
|----------------------|-----------------|----------------|
| `POST /devices` kind | `"reviewer"`    | `"agent"`      |
| `client` field       | `"attn-native"` | `"agent-cli"`  |
| `Participant.kind`   | `Reviewer`      | `Agent`        |
| Peer-strip chip      | round, monogram | hex, `⊳` glyph |
| Capabilities         | read/write findings | read/write findings |
| Can accept-suggest?  | no              | no             |

Owner-only capabilities (`RoomAdmin`, `AcceptSuggestion`,
`PublishSnapshot`) are NOT granted to agents — only the room owner
applies suggestions to their own file. Agents *submit*; the human
decides.

---

## Open Items

- `submit-comment` / `submit-suggestion` / `inbox` ship with
  attn-nnj.9.7. This doc covers the identity + join surfaces (9.6); the
  submit surfaces hook into the same `--as-agent` plumbing.
- Browser-hosted agents (`client: "attn-browser"` with `kind: "agent"`)
  are not yet specified. The relay accepts the combination; the UI
  story lands with Phase 6.
- Key rotation. There's no in-band rotation today — to rotate, delete
  the agent directory and `register-agent <name>` again. Existing
  comments stay attributed to the old pubkey because they're signed.
