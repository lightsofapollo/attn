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

2. Create the R2 bucket the worker binds to (`RELAY_BLOBS` → `attn-relay-blobs`):

       npx wrangler r2 bucket create attn-relay-blobs

### Deploy

       npm run deploy                       # production (top-level config)
       npx wrangler deploy --env staging    # staging worker (attn-relay-staging)

Validate the bundle offline first (no auth needed):

       npx wrangler deploy --dry-run --outdir /tmp/attn-relay-dryrun

The first production deploy applies migration `v1` (creates the `RoomDO` SQLite
class). Later deploys are migration no-ops unless a new `[[migrations]]` tag is
added.

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

### Required production secret

The R2 blob-access caps are HMAC-signed. **Before exposing a public
deployment**, set the signing key as a secret — otherwise the relay falls back
to a key derived from a public constant, which is forgeable from this open
source:

```bash
wrangler secret put BLOB_CAP_SIGNING_KEY     # any high-entropy string
```

(Unset is fine for local dev/tests; the fallback is deterministic so an isolate
verifies its own caps.)

### In-code defenses (already enforced)

| Defense | Where | Effect |
| --- | --- | --- |
| Per-IP **create** cap (15/min) | `rate-limit.ts` `checkCreate` + `index.ts` | throttles single-IP create floods at the edge |
| **Un-activated room eviction** (~15min) | `room-do.ts` `alarm()` probation | a room that never receives an event self-deletes, bounding accumulated DO/R2 cost regardless of creation rate |
| Create **body-size guard** (4 KiB) | `room-do.ts` `handleRoomCreate` | rejects oversized create bodies before buffering |
| PoW + admission HMAC + owner-sig | `pow.ts`, `admission.ts`, `owner-sig.ts` | gate writes/joins/deletes |

The per-IP create cap is in-memory (resets on isolate recycle) — an
order-of-magnitude defense, not a precise quota. Pair it with the WAF rule
below for a persistent edge limit.

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

### Known follow-up

- **PoW on room-create** is not yet enforced (other write/join/delete routes
  already verify `Attn-PoW`). The client mints all PoW at 12 bits but
  `create_room` sends no `Attn-PoW`, and `handleRoomCreate` doesn't verify one.
  Wiring it is cross-stack — client `bootstrap.rs::create_room` mints a token
  bound to `(roomId, ownerSigningKeyId)` at an agreed difficulty; the relay
  verifies via the existing `verifyPow` + `isPowSeen`/`markPowSeen` — and must
  update the per-file create helpers across all 11 integration test files.
  Tracked as a focused follow-up; the create-flood cost vector is already
  bounded by the per-IP cap + fast eviction + the WAF rule above.

## Status

Fully implemented. The vitest conformance corpus (`npm test`) covers caps,
owner-auth, multi-device, signaling routing, R2 spillover, TTL + idle-timeout
alarms, hibernation backfill, and PoW admission.
