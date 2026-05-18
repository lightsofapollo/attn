# attn-relay

Cloudflare Worker + Durable Object that brokers encrypted review envelopes for attn collab v2.

The server is an encrypted-envelope router with bounded storage and presence/signaling. It performs no markdown parsing, no merge, no decryption. See [planning/collab/relay-spec.md](../planning/collab/relay-spec.md) for the full contract.

## Dev

    npm install
    npm run dev    # boots Miniflare on :8787
    npm test       # runs vitest with workers pool

`wrangler dev --local` uses Miniflare to simulate the Durable Object + R2 bindings locally. The Rust client picks the relay URL up via `ATTN_RELAY_URL=http://localhost:8787`.

## Status

Scaffold only (issue attn-nnj.5.1). Endpoint implementations land in 5.2-5.15.
