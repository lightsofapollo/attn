# Landing cutover: retiring the split Vercel deployment

Date: 2026-07-10
Status: prepared — execution gated on attn-7xl.7 and explicit owner approval
Owner: attn web

This is the reversible procedure for moving `attn.sh` from the Vercel
SvelteKit landing (`site/`) to the unified Cloudflare worker
(`web/wrangler.production.jsonc`). **Nothing here is executed as part of
attn-7xl.1.4**; this document plus the prepared production config are the
deliverables. The production deploy and DNS change happen only in attn-7xl.7
after the owner signs off.

## 1. Current state (verified live 2026-07-10)

| Surface | Behavior |
|---|---|
| `https://attn.sh/` | Vercel-issued `307` → `https://www.attn.sh/` |
| `https://www.attn.sh/` | Vercel serves the old native-first landing (`site/`), title “attn — your markdown, rendered beautifully” |
| `https://www.attn.sh/review/:id` | **404** — production browser invites are broken today |
| `https://www.attn.sh/app` | 404 (route does not exist yet) |
| `https://staging.attn.sh/` | Cloudflare worker `attn-web-staging`: unified landing + `/app` + `/review` with pinned CSP/security headers |
| Native default | `DEFAULT_BROWSER_REVIEW_URL = https://attn.sh/review` (src/review/bootstrap.rs) — the cutover is what makes production invites work |
| Relay | `relay.attn.sh` already allowlists `https://attn.sh` in `ALLOWED_BROWSER_ORIGINS` |

The apex→www redirect direction **reverses** at cutover: the unified origin
is the apex (product decision #1), and `www` becomes a 308 redirect surface
handled inside the worker (`apexRedirectTarget`). Invite fragments
(`#key=…`) never reach the server and are reattached by browsers across the
redirect.

## 2. Parity status

Resolved in the hosted build (attn-7xl.1.1–.1.3):

- [x] Title/description/canonical/OpenGraph/Twitter metadata (exceeds the
      Vercel site, which ships no OG tags). Copy intentionally moves to the
      private-desk message — “parity” here means *quality*, not identical text.
- [x] `favicon.png`, `apple-touch-icon.png`, `icon.png` served from the same
      paths (`web/hosted/public/`).
- [x] Self-hosted Source Serif/Sans/Code (fontsource, hashed immutable).
- [x] Light/dark themes with `attn-theme` localStorage key — the same key the
      Vercel site uses, so returning visitors keep their preference.
- [x] Install paths: `brew install lightsofapollo/attn/attn`, `npx attnmd`,
      GitHub links.
- [x] Light/dark product screenshots (same captures as `site/static`).
- [x] No third-party scripts or analytics on either surface.

Accepted differences (documented, not gaps):

- Theme init is a CSP-safe module on the hosted build (no inline script), so
  a dark-preference first paint can flash paper→dark for one frame. The
  Vercel site used an inline script; the hosted CSP (`script-src 'self'`)
  forbids it. Accepted.
- The old landing’s feature tour (keyboard shortcuts, architecture diagram)
  is deliberately replaced by the browser-first three-part story per
  `00-web-presence.md`.

## 3. Prepared artifacts

- `web/wrangler.production.jsonc` — worker `attn-web`, custom domains
  `attn.sh` + `www.attn.sh`, `RELAY_ORIGIN=https://relay.attn.sh` (drives the
  worker CSP `connect-src`).
- Worker `www.*` → apex 308 (`web/src/lib/hosted/csp.ts::apexRedirectTarget`,
  unit-tested).
- CSP builder parameterized by relay origin (`buildContentSecurityPolicy`,
  unit-tested for staging and production origins).

## 4. Cutover procedure (attn-7xl.7, owner-approved only)

Pre-flight:

1. `staging.attn.sh` green: `npm run test:e2e:routes` against a fresh staging
   deploy, plus the real iPhone/iPad Safari matrix from `06-validation-rollout.md`.
2. Confirm relay production vars still allowlist `https://attn.sh`.
3. Capture “before” screenshots of `www.attn.sh` (light/dark, desktop/mobile)
   for the parity record.

Cutover (each step independently reversible):

4. Build with the production relay:
   `VITE_ATTN_RELAY_URL=https://relay.attn.sh npm run build:browser && npm run check:route-bundles`.
5. Verify the review entry embeds `https://relay.attn.sh` (mirror of the
   staging deploy script’s `verifyBuild`).
6. `npx wrangler deploy --config wrangler.production.jsonc`. Adding the
   `attn.sh` / `www.attn.sh` custom domains detaches Vercel’s DNS records for
   those hosts (Cloudflare manages the zone). Note the previous DNS record
   values first (CNAME targets), so rollback is a paste.
7. Verify live matrix (see §5).
8. Leave the Vercel project and `site/` untouched for one full release cycle —
   it is the rollback target. Removal of Vercel ownership and `site/` is a
   separate final step inside attn-7xl.7 after the soak.

Rollback (any failure):

- Re-point `attn.sh`/`www.attn.sh` DNS back to the recorded Vercel CNAMEs (or
  remove the worker custom domains, restoring the prior records) — the Vercel
  deployment is still live and unchanged. No data is at risk: the hosted
  surface stores nothing server-side beyond the relay, which is unchanged.

## 5. Post-cutover verification matrix

```
curl -sI https://attn.sh/                 # 200, CSP present, cache-control: no-store
curl -sI https://www.attn.sh/anything     # 308 → https://attn.sh/anything
curl -sI https://attn.sh/review/probe     # 200 (review entry HTML, no redirect)
curl -sI https://attn.sh/app/w/x/y.md     # 200 (app entry HTML, no redirect)
curl -s  https://attn.sh/ | grep '<title>'   # private-desk title
```

- Full Playwright suite against production origin.
- Native → browser invite: share from native attn, open the generated
  `https://attn.sh/review/…#key=…` link in a clean browser profile.
- Fresh-HTML check: staging has shown `cf-cache-status: HIT` on HTML despite
  `no-store`. After deploy, fetch `/` **without** a cache-busting query from a
  cold client and confirm the new build’s hashed entry path; purge the zone
  cache if stale.
- iPhone Safari: landing, `/app` shells, and a review link on a real device.

## 6. Explicit non-goals of attn-7xl.1.4

- No production deploy, no DNS change, no Vercel project deletion, no
  `site/` removal. All of that is attn-7xl.7, behind owner approval.
