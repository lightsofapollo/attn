# Phase 01 validation record — workspace storage v3

Date: 2026-07-11 (attn-7xl.2.7)

Reproducible from `web/` unless noted.

| Gate (01-storage-foundation.md §Validation) | Command | Result |
|---|---|---|
| Svelte/TS check | `npm run check` | 0 errors, 0 warnings |
| Storage unit suites | `npm test` | 51 test files, 0 failures — includes browser-storage (8), workspace schema (10), workspace crypto (9), workspace store (13), OPFS tier (7), probes (8), leases (6), validation extras (2) |
| Migration corpus | `browser-workspace-schema.test.ts` | empty, v1, v2, interrupted-claim, and corrupt-v3 fixtures: legacy rooms/inbox/cursors survive, claims stay hidden and roll back, corruption fails loudly with the DB re-openable |
| Property tests | `browser-workspace-validation.test.ts` | seeded 120-step random op sequence (76 mutating ops): clocks never regress, heads match the model, history clocks ascend uniquely, paths stay unique, stale optimistic commits always conflict. Plus targeted atomic-head, conflicting-lease, idempotent-commit, crypto-erasure cases in the per-module suites |
| Fault injection | unit suites | injected QuotaExceededError (proxy IDB) preserves the last committed head and recovers; transaction aborts leave prior state; OPFS write failure and corrupt read fail closed with IDB fallback; missing OPFS degrades capacity only; orphan files swept via write-ahead GC intents |
| Real Chromium + WebKit persistence/reload | `npm run test:e2e:storage` | 8/8 (4 per engine): create/commit survives reload with intact history; 700 KiB body persists via OPFS (Chromium) / honest fallback; capability probe reports truthful modes (WebKit ephemeral contexts refuse OPFS → volatile, verified consistent); cross-tab lease keeps a second context read-only |
| Manual current iOS Safari | — | **Pending human/device gate** — consolidated with the epic's mandatory real iPhone/iPad matrix in attn-7xl.7 (normal tab, Private Browsing, Home Screen app, denied persistence, storage clear, low storage). Tracked as a gate bead under attn-7xl.2. |
