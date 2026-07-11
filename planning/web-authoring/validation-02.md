# Phase 02 validation record — local browser authoring

Date: 2026-07-11 (attn-7xl.3.6)

Reproducible from `web/`.

| Gate (02-local-authoring.md §Validation) | Command | Result |
|---|---|---|
| Svelte/TS check | `npm run check` | 0 errors, 0 warnings |
| Unit tests | `npm test` | 54 files, 0 failures — incl workspace service (9), autosave (5), import/export incl zip round-trip + traversal (8) |
| One-click → type → reload → edit → export → reimport, zero relay traffic | `npm run test:e2e:routes` (hosted-authoring "phase gate") | single continuous Playwright journey from the landing CTA through real ProseMirror typing, durable autosave, reload recovery, a 1.2 MB asset, zip export verified byte-for-byte in Node, zip reimport landing in prose — with request interception proving **zero non-origin requests** end to end |
| Nested multi-file + raster/unknown assets + 1 MiB bodies, OPFS and IDB fallback | routes + storage suites | nested create/rename in the rail, decoded PNG inline preview (naturalWidth check), download-only placeholders, 1.2 MB asset export/reimport byte-identical; 700 KB body persists via OPFS (Chromium) and honest fallback (WebKit ephemeral) in `npm run test:e2e:storage` |
| Two-tab writer lease/takeover; no silent overwrite | routes + storage suites | second tab gets an honest read-only state and takes over only after Done; storage-level cross-tab lease test on both engines; fenced commits reject stale holders (unit) |
| Mobile Chromium/WebKit viewport suite | `npm run test:e2e:storage` (hosted-reader) | 320/375/390/430 px + 820/1024: measure 18–19 px, zero page overflow, ≥44 px dock/toolbar targets, reading-position round-trips, lightbox focus, quota view-only with Open native, formatting bar + title target durable edits — 30/30 across Chromium AND WebKit |
| Cloudflare staging | `npm run deploy:staging` + `ATTN_ROUTES_BASE_URL=https://staging.attn.sh …` | deployed and authoring suite green against the live origin |
| Real iPhone/iPad Safari matrix | — | **Pending human/device gate** — consolidated into the attn-7xl.7 device session (with attn-7xl.2.9) |
