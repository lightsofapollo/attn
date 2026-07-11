# Phase 00 validation record — unified web presence

Date: 2026-07-10 (attn-7xl.1.5)
Staging deploy: `attn-web-staging` version `a4234267-7e13-4ffa-90d1-e12ecc56b99a`

Every command below is reproducible from `web/`.

| Gate (00-web-presence.md §Validation) | Command | Result |
|---|---|---|
| Svelte/TS check | `npm run check` | 1335 files, 0 errors, 0 warnings |
| Unit tests | `npm test` | 44 test files, 0 failures |
| Browser build | `npm run build:browser` | green; entries `landing-*`, `app-*`, `review-*` |
| Route bundle boundaries | `npm run check:route-bundles` | landing (6 files) and app (10 files) static graphs contain no ProseMirror/Mermaid/KaTeX/@noble/review-protocol/WebRTC modules (module-id precision via `.vite/chunk-modules.json`) |
| Routes + shells + degraded states (local worker) | `npm run test:e2e:routes` | 40/40 vs `wrangler dev` (real worker rewrites + headers) |
| Desktop + iPhone screenshots | part of the suite | `test-results/landing-*.png`, `test-results/shell-*-{desktop,mobile}.png` — all five designed pages plus private-browsing degraded desk, light + dark landing |
| Keyboard-only + axe audit | `hosted-a11y.spec.ts` (in suite) | axe WCAG 2.x A/AA: 0 violations on landing, desk, editor, storage, open, both degraded desks, open share sheet, mobile files sheet. Keyboard-only: landing CTAs reachable, share sheet Enter/Escape + focus restore, storage destructive confirm operable |
| No horizontal scroll at 320 px | in suite | landing, desk, editor, storage, open, share-open all 0 px overflow |
| Cloudflare preview, same origin + CSP | `npm run deploy:staging` then `ATTN_ROUTES_BASE_URL=https://staging.attn.sh npx playwright test --config playwright.routes.config.ts` | deploy verified live (`/assets/review-TsUxmM51.js` embeds relay-staging origin); 40/40 against the deployed origin; curl smoke: `/`, `/app`, `/app/storage`, `/open`, deep workspace path, `/review/:roomId` all 200, one origin, pinned CSP |

## Issues found and fixed during this gate

- `.file-size` labels used `--faint` and failed axe color-contrast (serious)
  on editor/file surfaces → moved to `--muted`.
- axe contrast sampling was flaky until webfonts/images finished loading on
  cold network loads → the a11y helper now awaits `document.fonts.ready` and
  image completion before scanning.

## Deliberately out of Phase 00 scope (tracked later in the epic)

- WebKit engine runs and the real iPhone/iPad Safari device matrix
  (attn-7xl.7 / 06-validation-rollout.md).
- Production attn.sh cutover — prepared in
  [07-landing-cutover.md](07-landing-cutover.md), gated on owner approval.
