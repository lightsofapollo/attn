# Parity validation and production rollout

Depends on: Phase 03, Phase 04, and Phase 05

## Purpose

Validate the complete local-create-to-cross-client-share journey, security
boundaries, accessibility, and one-origin production cutover.

## Implementation steps

### Step 1 — Build the complete parity matrix

Cover browser owner/browser reviewer, browser owner/native reviewer, native
owner/browser reviewer, multiple browsers, owner offline/reconnect, direct RTC,
forced mailbox fallback, nested multi-file workspaces, images/unknown assets,
missing relative references, R2, comments, replies, resolution,
suggestions, co-editing, reload, export/import, and invalid invites.

### Step 2 — Complete security and privacy review

Threat-model same-origin code, local compromise, invite capability persistence,
owner identity, service worker, imports, XSS/sanitization, CSP/Trusted Types,
relay/R2 blindness, logs/traces, crypto-erasure, and dependency supply chain.

### Step 3 — Complete accessibility and performance gates

Keyboard/screen-reader/touch coverage, reduced motion, contrast, 320 px layout,
landing route bundle, editor interaction latency, autosave latency, cold launch,
large workspace memory, and iOS process-restart behavior.

### Step 4 — Cut over the canonical origin

Deploy staging, run the full matrix, move `attn.sh` from the split Vercel site to
the Cloudflare hosted worker, preserve redirects/metadata, verify production,
and retain rollback to the prior static landing plus review app.

### Step 5 — Document product and recovery contract

Update README, landing, help text, security docs, browser support policy, backup
instructions, and native/browser invite behavior. Explicitly state that server
operators cannot recover content or keys.

## Validation

- `cargo fmt --check`
- `cargo check -p attn`
- `cargo nextest run -p attn -j 1`
- `npm --prefix web run check`
- `npm --prefix web test`
- `npm --prefix web run build:browser`
- `npm --prefix relay run typecheck`
- `npm --prefix relay test`
- Local and Cloudflare-staging Playwright parity matrix.
- Current iPhone and iPad Safari release checklist signed off with screenshots
  and version/device metadata.
- Independent code, security, accessibility, and content-blindness reviews.
- Production `attn.sh` smoke plus rollback rehearsal before closing the epic.
