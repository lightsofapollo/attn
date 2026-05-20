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

## Status

Fully implemented. The vitest conformance corpus (`npm test`) covers caps,
owner-auth, multi-device, signaling routing, R2 spillover, TTL + idle-timeout
alarms, hibernation backfill, and PoW admission.
