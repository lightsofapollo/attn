# Hosted performance evidence — 2026-07-20 (attn-7xl.7.3)

Measured on the production build (`npm run build:browser`) served by the
real Cloudflare worker (`wrangler dev`, localhost), Chromium, fresh
browser context per run. Localhost removes network variance — these are
compute/architecture numbers; add real-network latency mentally for
first-visit fetches.

## Measurements

| Dimension | Measured | Proposed budget | Verdict |
|---|---|---|---|
| Landing JS (`/`) | 28 KB over 8 chunks | ≤ 75 KB | PASS |
| Landing CSS | 10 KB | ≤ 30 KB | PASS |
| Landing total transfer (incl. hero AVIF) | 198 KB | ≤ 350 KB | PASS |
| Landing → product-chunk isolation | route-bundle gate green (no editor/crypto preload) | gate stays green | PASS |
| Cold launch `/app#new` → editor interactive | 323 ms | ≤ 1500 ms (localhost) | PASS |
| App JS total (lazy, all 31 chunks) | 4.7 MB | ≤ 6 MB, split-loaded | PASS (watch) |
| Keystroke → paint, empty doc (60 keys) | p50 0.4 ms / p95 1.8 ms | p95 ≤ 16 ms (one frame) | PASS |
| Keystroke → paint, large workspace + big doc | p50 0.6 ms / p95 4.5 ms | p95 ≤ 16 ms | PASS |
| Autosave settle after a typing burst | 1.18 s (≈1 s debounce + ~180 ms commit) | ≤ 2 s | PASS |
| Large workspace (63 files incl. 2 MB doc) heap | 28 MB used | ≤ 150 MB | PASS |
| Large workspace cold reopen (reload → interactive) | 304 ms | ≤ 2 s | PASS |
| 2 MB single document | Editor safe-mode preview engages (>50k chars) | guard stays | PASS (by design) |

## Notes

- The hero image is back on responsive AVIF (`ResponsiveScreenshot`)
  with intrinsic dimensions; the landing CLS/payload gate asserts it.
- The 4.7 MB lazy app payload is the one line worth watching: it is
  split across 31 route-gated chunks (nothing loads on the landing), but
  compression-dictionary/minification work would pay off before any
  bandwidth-constrained launch market matters.
- iOS process-restart behavior cannot be measured here — it lives in the
  consolidated real-device checklist (attn-7xl.2.9 / 6.6 session).
