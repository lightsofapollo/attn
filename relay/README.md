# attn-relay

Cloudflare Worker + Durable Object that brokers encrypted review envelopes for attn collab v2.

The server is an encrypted-envelope router with bounded storage and presence/signaling. It performs no markdown parsing, no merge, no decryption. See [planning/collab/relay-spec.md](../planning/collab/relay-spec.md) for the full contract.

## Dev

    npm install
    npm run dev    # boots Miniflare on :8787
    npm test       # runs vitest with workers pool (full conformance corpus)
    npm run typecheck

`wrangler dev --local` uses Miniflare to simulate the Durable Object + R2 bindings locally. The Rust client picks the relay URL up via `ATTN_RELAY_URL=http://localhost:8787`.

For the full local collab stack (relay + two daemons) see the repo root: `task dev:collab`. The 3-party live UI E2E is `task test:3party`.

## Deploy

The relay targets Cloudflare Workers (Durable Objects + R2). One-time setup per
account, then `npm run deploy`. `account_id` is not committed — wrangler resolves
it from your login or `CLOUDFLARE_ACCOUNT_ID`.

### One-time setup

1. Authenticate wrangler:

       npx wrangler login                  # interactive, or:
       export CLOUDFLARE_API_TOKEN=…        # headless/CI (needs Workers Scripts
                                            # edit + R2 edit scopes)

2. Create the isolated production and staging R2 buckets:

       npx wrangler r2 bucket create attn-relay-blobs
       npx wrangler r2 bucket create attn-relay-blobs-staging

3. Configure R2 lifecycle rules so the seven-day expiry targets only room
   ciphertext (`rooms/` and `rooms_v2/`). Do not apply that rule to
   `shares_v1/`: ShareDO retains the latest encrypted snapshot per file until
   supersession, owner revocation, or the owner-renewed 90-day share expiry.
   Its alarm-driven tombstone cleanup is the authoritative deletion path.

### Deploy

       npm run deploy                       # production (top-level config)
       npx wrangler deploy --env staging    # staging worker (attn-relay-staging)

Validate the bundle offline first (no auth needed):

       npx wrangler deploy --dry-run --outdir /tmp/attn-relay-dryrun

The migrations create three SQLite-backed Durable Object classes: `v1` creates
`RoomDO`; `v2` creates the singleton `QuotaDO`; `v3` creates `ShareDO`. Later deploys are migration
no-ops unless another `[[migrations]]` tag is added.

### URL + client wiring

Without a custom domain the worker is reachable at
`https://attn-relay.<your-subdomain>.workers.dev`. Point clients at it:

       ATTN_RELAY_URL=https://attn-relay.<subdomain>.workers.dev attn <file.md>

For a stable domain (e.g. `relay.attn.dev`), add a Custom Domain under
Workers → attn-relay → Triggers in the dashboard, or a `routes` entry in
`wrangler.toml` once the zone lives in your account. Shipped builds should
default `ATTN_RELAY_URL` to that domain.

### Browser origins

`ALLOWED_BROWSER_ORIGINS` (in `[vars]`) gates `policy.allowBrowser` rooms by
`Origin`. Native clients send no `Origin` and bypass the check. Update it if the
app/marketing domains change; `[env.staging]` overrides it for staging.

### CI

`.github/workflows/relay-deploy.yml` deploys on **manual dispatch** (Actions tab
→ "Relay Deploy" → choose `staging`/`production`). It typechecks + runs the full
test suite before deploying. Requires repo secret `CLOUDFLARE_API_TOKEN` (and
optionally `CLOUDFLARE_ACCOUNT_ID`).

## Abuse / cost hardening (ops)

The relay is account-free and E2E-encrypted (it only ever stores ciphertext).
Abuse protection is therefore layered, account-free, and aimed at the top cost
vector: cheap room creation (each room = a Durable Object + SQLite + an alarm).

### Required production secrets

The R2 blob-access caps and quota-source identifiers are HMAC-signed.
**Before exposing a public deployment**, set both secrets; missing or short
keys fail closed:

```bash
wrangler secret put BLOB_CAP_SIGNING_KEY     # any high-entropy string
wrangler secret put QUOTA_IP_HASH_KEY         # independent high-entropy string
```

Local tests set explicit non-production keys. Public deployments have no
fallback for either secret.

`QUOTA_IP_HASH_KEY` has no production fallback: first-create fails closed with
`503 ATTN_QUOTA_UNAVAILABLE` when it is absent, while reads, deletes, and room
rejoins continue to use existing room state. Set the staging secret separately
with `wrangler secret put QUOTA_IP_HASH_KEY --env staging`. The Worker HMACs the
canonical `CF-Connecting-IP` value before it crosses into Durable Object
storage; it never persists a raw IP and never uses `X-Forwarded-For` for durable
quota. `QUOTA_ALLOW_UNATTRIBUTED_CREATES=true` is a local/vitest-only escape
hatch and must not be enabled on a public deployment.

### In-code defenses (already enforced)

| Defense | Where | Effect |
| --- | --- | --- |
| Per-IP **create** cap (15/min) | `rate-limit.ts` `checkCreate` + `index.ts` | throttles single-IP create floods at the edge |
| Atomic source + global room quota | singleton SQLite `QuotaDO` | reserves 25 MiB per live room before metadata creation; bounds durable cost across Worker isolates |
| **Un-activated room eviction** (~15min) | `room-do.ts` `alarm()` probation | a room that never receives an event self-deletes, bounding accumulated DO/R2 cost regardless of creation rate |
| Create **body-size guard** (4 KiB) | `room-do.ts` `handleRoomCreate` | rejects oversized create bodies before buffering |
| **PoW** + admission HMAC + owner-sig | `pow.ts`, `admission.ts`, `owner-sig.ts` | gate **create** + writes/joins/deletes (every mutating route now verifies `Attn-PoW`) |

The per-IP create cap is in-memory (resets on isolate recycle) — an
order-of-magnitude defense, not a precise quota. Pair it with the WAF rule
below for a persistent edge limit.

### Conservative reserved-capacity quota

Every accepted first-create reserves exactly `HARD_MAX_ROOM_BYTES` (25 MiB),
even while the room is empty. Pending and full reservations therefore consume
capacity immediately. The default deployment limits are:

- 8 simultaneous live rooms per HMAC-pseudonymized source;
- 256 MiB allocated per source in a rolling 24-hour window (allocation is
  ingress and is not refunded when a room is deleted early);
- 512 simultaneous live rooms globally; and
- 6.25 GiB globally reserved, which is the tighter limit at 256 full-room
  reservations.

Explicit delete, hard TTL, idle expiry, and unactivated-room probation clean
the room ciphertext first and then idempotently release the live reservation.
The generation lease is `(roomId, random leaseId)`, so a delayed cleanup cannot
decrement a newly recreated room. Room rejoin never acquires a new reservation
and remains available when quota attribution or the coordinator is unavailable.

R2 upload capabilities are bound to the room's random generation and a
one-time upload claim. The RoomDO serializes upload with delete/expiry, so an
old cap cannot overwrite a recreated room or resurrect bytes after quota is
released. Production and staging use separate buckets.

These quotas account for encrypted capacity only. They do not parse, decrypt,
classify, or otherwise inspect user content; the service can see ciphertext
lengths and routing metadata, never document or comment plaintext.

### Cloudflare dashboard config (apply once)

1. **WAF rate-limiting rule** — Security → WAF → Rate limiting rules:
   - Match: `http.request.method eq "POST" and http.request.uri.path matches "^/v2/rooms/[^/]+$"`
   - Rate: e.g. **30 requests / 1 min** per client IP
   - Action: **Managed Challenge** (or Block) for the period.
   This is the persistent per-IP create cap (survives isolate recycles).
2. **Abuse alert** — Notifications → alert on a spike in `POST /v2/rooms/*`
   request rate or 429s, so a create flood is visible before it hits the bill.
3. (Future, in-browser reviewer only) **Turnstile** on the hosted review page —
   the native app has no browser, so PoW is the native-side equivalent.

### PoW on room-create

Room-create now verifies `Attn-PoW` like every other mutating route. The client
(`bootstrap.rs::create_room`) mints a token bound to `(roomId,
ownerSigningKeyId, POST, /v2/rooms/:roomId)` — `ownerSigningKeyId =
base64url(SHA-256(ownerSigningKey))`, which the relay derives from the body, so
no extra wire field — at the `MIN_POW_BITS` floor, replay-protected via the
shared `pow_seen` set. The floor is currently the minimum (the client's mint
difficulty); raise it for a stronger per-create cost once the test PoW miner is
made sync (the async miner makes high difficulties slow in the suite).

## Status

Fully implemented. The vitest conformance corpus (`npm test`) covers caps,
owner-auth, multi-device, signaling routing, R2 spillover, TTL + idle-timeout
alarms, hibernation backfill, and PoW admission.
