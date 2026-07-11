# Relay Conformance Corpus

> V3 scoped-admission coverage lives in `test/integration/v3-admission.test.ts`
> plus the self-contained semantic corpus action `v3AdmissionMatrix`. It
> exercises read success, every mutating endpoint's read-capability rejection,
> write success, and protocol mismatch. The Rust corpus interpreter does not
> yet have v3 room/key/scope vocabulary; `requires: ["v3-admission-matrix"]`
> records that explicit harness debt until the Rust v3 client lands.
> Durable shares likewise use the self-contained semantic corpus action
> `durableShareMatrix` until the native share client lands. It locks create,
> public redaction, scoped read, mailbox retry idempotency, and revocation to
> the same executable corpus rather than leaving the new surface test-only.
> `shareArtifactMatrix` covers owner upload, survival across the room-prefix
> sweep, latest-per-file supersession, read-admission fetch, and revoke cleanup.
> `shareTierBundleMatrix` locks exact bundle selection, view write denial, and
> independent comment/suggest mailbox authorization without exposing siblings.

Cross-language conformance suite for the attn relay. The same `cases.json`
is consumed by:

1. **`replay.test.ts`** (this directory) — vitest suite that replays every
   scenario against the Miniflare-backed Worker via `SELF.fetch` /
   `SELF.fetch(ws)`.
2. **Rust transport tests** (`attn-nnj.6.7`) — runs the same JSON through
   the Rust client against `wrangler dev --local`, proving wire-format
   parity between TypeScript and Rust.

The corpus is the **executable** form of the §Test Plan acceptance suite
in `planning/collab/relay-spec.md`. New behavior the spec adds should
land here as a new scenario so both runtimes stay locked together.

## Why a corpus (not just integration tests)?

The Rust transport doesn't share code with the relay or the TypeScript
helpers — without a shared corpus, "the Rust client agrees with the
relay" can only be checked by hand. The corpus is a single source of
truth: a regression in one runtime shows up as the same scenario
failing, and any new scenario forces both sides to implement the same
behavior.

## Format

`cases.json` is a serde-deserializable document:

```jsonc
{
  "version": 1,
  "description": "...",
  "scenarios": [
    {
      "id": "happy-room-lifecycle",
      "name": "Room lifecycle — create, register, post, subscribe, ack, delete",
      "spec": "relay-spec.md §Test Plan #1",
      "tags": ["lifecycle", "happy-path"],
      "steps": [
        { "action": "createRoom", "as": "room1", "params": { ... } },
        { "action": "registerDevice", "in": "room1", "as": "dev-owner", "params": { ... } },
        ...
      ]
    },
    ...
  ]
}
```

### Top-level fields

- `version` — integer; bumped when the schema changes incompatibly.
- `description` — free-form text.
- `scenarios` — ordered list of scenarios.

### Scenario fields

| Field         | Type                          | Required | Meaning                                                                                          |
| ------------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `id`          | string (kebab-case)           | yes      | Unique identifier. Used as the vitest test name and the Rust test id.                            |
| `name`        | string                        | yes      | Human-readable summary.                                                                          |
| `spec`        | string                        | no       | Pointer back to the spec section the scenario covers.                                            |
| `tags`        | string[]                      | no       | Filter tags (e.g. `["pow"]`, `["ws"]`, `["cap"]`).                                               |
| `requires`    | string[]                      | no       | Feature flags this scenario needs (e.g. `["r2-spillover"]`). Runners may skip if unmet.          |
| `steps`       | Step[]                        | yes      | Ordered list of actions + expectations.                                                          |

### Step actions

Each step has an `action` discriminator. The corpus deliberately models
**actions** rather than raw HTTP requests so the same JSON survives:

- runtime differences (Miniflare admission HMAC vs. Rust admission HMAC)
- crypto material (Ed25519 keypairs, PoW nonces) being minted at replay
  time, never serialized into the corpus
- mock-clock vs. wall-clock implementations of TTL / idle timeouts

| `action`                  | Purpose                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `createRoom`              | `POST /v2/rooms/:roomId` (no admission). `params.policy` is the room policy.                             |
| `recreateRoom`            | Second `POST /v2/rooms/:roomId` with admission (rejoin path).                                            |
| `registerDevice`          | `POST /v2/rooms/:roomId/devices` (admission + PoW + selfSig).                                            |
| `listDevices`             | `GET /v2/rooms/:roomId/devices` (admission).                                                             |
| `postEnvelopes`           | `POST /v2/rooms/:roomId/envelopes` (admission + PoW). `params.envelopes` is the batch.                   |
| `postAcks`                | `POST /v2/rooms/:roomId/acks` (admission + PoW [+ optional owner-sig]).                                  |
| `deleteRoom`              | `DELETE /v2/rooms/:roomId` (admission + PoW + owner-sig).                                                |
| `openSocket`              | WS upgrade `/v2/rooms/:roomId/socket?device_id=…` with admission via `Sec-WebSocket-Protocol`.            |
| `sendFrame`               | Send a JSON text frame on a previously opened socket.                                                    |
| `expectFrame`             | Block up to `params.timeoutMs` for the next inbound frame; assert its shape.                             |
| `expectClose`             | Assert the socket closed with `params.code` within `params.timeoutMs`.                                   |
| `closeSocket`             | Client-side close.                                                                                       |
| `sleep`                   | Wait `params.ms` milliseconds (use sparingly — prefer `expectFrame`/`expectClose`).                      |
| `advanceMockClock`        | Advance the runner's mock clock by `params.ms`. Used for hard-max / idle-timeout scenarios.              |
| `seedR2Blob`              | Pre-populate an R2 object under `rooms/<roomId>/<key>`. Used for R2 spillover / cleanup tests.           |
| `listR2`                  | Enumerate R2 keys under a prefix; assert exact membership.                                               |
| `shareArtifactMatrix`     | Replay durable share snapshot pin/supersede/fetch/revoke semantics with relay-minted R2 keys.            |
| `shareTierBundleMatrix`   | Replay strict per-tier share bundle selection and independent mailbox admission.                         |
| `expectStorageState`      | Peek inside DO storage (Miniflare: `runInDurableObject`; Rust: not applicable — skipped).                |

### Naming via `as` / `in`

Most actions take an `as` string. Subsequent steps use `in` (for room
context) and `from`/`target` (for device context) to refer back to
previously named entities. The runner keeps a per-scenario symbol table
that maps these logical names to the materialized identifiers used on
the wire (real roomIds, deviceIds, sockets, keypairs).

This indirection means the corpus never contains opaque hex blobs — a
human reading `cases.json` can follow the scenario from start to finish.

### Expectations

Each request-style step may carry an `expect` block:

```jsonc
{
  "action": "postEnvelopes",
  "in": "room1",
  "from": "dev-a",
  "params": { "envelopes": [...] },
  "expect": {
    "status": 201,
    "bodyShape": {
      "accepted": [
        { "envelopeId": "env-001", "serverSeqAtLeast": 1 }
      ]
    }
  }
}
```

`bodyShape` describes structural assertions that survive non-determinism
(server seq numbers, timestamps, etc.):

- exact equality on string/number fields where you write a primitive
- `serverSeqAtLeast: N` lets the corpus require monotonicity without
  pinning a specific seq
- `roomId`, `deviceId`, `envelopeId` in expectations resolve through the
  runner's symbol table

### Error expectations

```jsonc
"expect": {
  "status": 400,
  "errorCode": "ATTN_BATCH_TOO_LARGE"
}
```

The runner asserts `status === expect.status` and, if `errorCode` is
present, `body.error.code === expect.errorCode`.

## How Rust 6.7 consumes this

The Rust runner (`relay-client/tests/conformance.rs`, owned by
attn-nnj.6.7) deserializes `cases.json` with `serde_json` into a mirror
of the schema documented above. For each scenario it walks the steps
through the production `attn-relay-client` crate, asserting:

- HTTP status codes match `expect.status`
- response bodies match `expect.bodyShape` after canonicalization
- WS frames match `expect.frame` after canonicalization
- close codes match `expect.code`

Steps tagged `requires: ["miniflare-only"]` (e.g. `expectStorageState`)
are skipped on the Rust side; everything else MUST run identically.

## Contributing a new scenario

1. **Add a numbered entry** to the `scenarios` array. Use a kebab-case
   `id`, link back to the spec section with `spec`, and tag it.

2. **Prefer reuse over copy-paste.** Most scenarios start with the same
   `createRoom` + `registerDevice` pair — that's fine, just keep the
   `as` names readable (`owner`, `reviewer-1`, etc.).

3. **Use the mock clock for time-sensitive cases.** Real `sleep`s slow
   the suite linearly and rarely work in Rust. Prefer
   `advanceMockClock` + an explicit `expectFrame` /
   `expectClose`.

4. **Run both sides locally.** `npm test -- conformance` runs the TS
   replay. Once attn-nnj.6.7 lands, `cargo test -p attn-relay-client --
   conformance` runs the Rust side.

5. **Keep error scenarios on a separate room id.** A scenario should be
   the smallest path that exercises the behavior — no cross-scenario
   coupling.

6. **Bump `version`** in `cases.json` only when you make a backward-
   incompatible schema change (new `action` discriminants are additive
   and don't require a bump; renaming or removing fields does).

## Mock clock contract

Scenarios that use `advanceMockClock` only work when the runner's
implementation provides a clock that the relay observes. The Miniflare
runner exposes this via direct DO storage mutation
(`meta:expires_at` / `meta:idle_deadline`) and an explicit
`forceAlarm()` call to fire the DO alarm. The Rust runner mirrors that
by issuing the same admin-only test-mode RPC. Scenarios MUST NOT mix
mock-clock advances with real `sleep`s — pick one strategy per
scenario.

## Files in this directory

- `cases.json` — the corpus (versioned, language-agnostic).
- `replay.test.ts` — vitest runner; calls the relay via Miniflare.
- `runner.ts` — interpreter that walks scenario steps; shared
  between this directory and any future TS-side tooling that needs
  to replay scenarios outside vitest.
- `README.md` — this file.
