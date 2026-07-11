# Browser/native release parity matrix

Date: 2026-07-11 (attn-7xl.7.1)

This matrix records the repeatable evidence for the accountless browser
workspace release. `PASS` cells have an automated command. `DEVICE GATE` cells
require current physical Apple hardware and remain tracked by attn-7xl.2.9 and
attn-7xl.7.6; they are not silently treated as simulated passes.

## Owner/reviewer and transport matrix

| Owner | Reviewer | Stable/live path | Mailbox/offline path | Direct path | Result and command |
|---|---|---|---|---|---|
| Browser | Browser | Production durable-share resolver joins the browser-owned V3 RoomDO | Browser owner validates reviewer registration/grants/events, forwards exact ciphertext, ACKs ShareDO, and seals cursor | Browser transport/collab controller suites exercise direct-first delivery | **PASS** — `npm --prefix web run test:share-owner:live`, `npm --prefix web test` |
| Browser | Native | Native Rust resolves the selected stable bearer, authenticates the manifest/sealed bundle, and registers in the browser-owned room | Same room/mailbox protocol; owner-side browser drain is covered with exact frozen browser submissions | V3 room capabilities feed the existing native transport | **PASS** — `npm --prefix web run test:share-owner:live`, `cargo test --lib share_lifecycle` |
| Native | Browser | Production browser resolves retained ciphertext and upgrades into the actual native RoomDO | Comment survives destroyed RoomDO; owner restart recreates the deterministic epoch, imports/forwards/ACKs, and the existing browser upgrades without reload | Browser and native daemons negotiate a real DataChannel | **PASS** — `scripts/test-share-e2e.sh`, `scripts/test-webrtc-live-e2e.sh` |
| Native | Native | Existing canonical share/join path | Existing relay mailbox and restart paths | Real two-daemon DataChannel with comment, co-edit, and tracked suggestion | **PASS** — `scripts/test-webrtc-live-e2e.sh`, Rust review suites |
| Multiple browser tabs | Browser-owned workspace | One workspace lease/fencing token owns mutations; passive tabs are read-only until takeover | Pending ciphertext resumes byte-identically after reload/tab handoff | Per-file controller generation rejects stale deliveries | **PASS** — `browser-workspace-lease`, `browser-workspace-sharing`, `browser-owner-workspace-runtime`, and `browser-owner-authority` suites under `npm --prefix web test` |

## Content, action, and recovery matrix

| Cell | Required behavior | Result and evidence |
|---|---|---|
| Current file / selected entries / whole workspace | One canonical normalized manifest; stable FileIds; pointer publishes last | **PASS** — browser snapshot publisher/workspace manifest suites |
| Nested Markdown | Multiple files remain distinct and publish in one room; new files publish live | **PASS** — `scripts/test-folder-share-e2e.sh` (3/3) plus browser publisher tests |
| Raster and arbitrary binary assets | Raw bytes hash/length/media type are manifest-bound; binary is base64url inside E2EE snapshot; active/unknown content is not executed | **PASS** — browser snapshot publisher, session hydration, manifest, shell, and import/export suites |
| Missing/stale paths and references | Stale scope paths fail before network; deleted/renamed entries reconcile; missing assets remain inert | **PASS** — browser workspace sharing/store/manifest suites and hosted authoring Playwright |
| Mailbox and R2 thresholds | Small sealed snapshot uses mailbox; large sealed body uses authenticated same-origin R2 capability; swapped body/AAD fails | **PASS** — browser snapshot publisher/R2 suites; relay remains content-blind |
| Comments, replies, resolution | Signed events render, retry byte-identically, and owner terminal actions persist before broadcast | **PASS** — browser session, owner authority, review actions, selectors/margin suites; WebRTC live comment gate |
| Suggestions and apply | Comment tier cannot escalate; suggest tier is room-bound; accept/reject/apply uses fenced atomic receipts and survives autosave | **PASS** — browser session/authority/review-action suites; WebRTC tracked-suggestion gate |
| Co-editing | Owner is the single authority; checkpoint persists before commit/broadcast; concurrent editors converge | **PASS** — collab authority/controller/session suites; WebRTC live co-typing |
| Owner offline / reconnect | Stable reviewer can author offline; owner recreates same epoch, forwards once, ACKs after durability, and renews 90-day ShareDO | **PASS** — durable-share real stack and browser coordinator recovery tests |
| Reload and process restart | Sealed capability, pending exact ciphertext, rollback floor, outbox, and owner checkpoint resume without duplicate apply | **PASS** — browser storage/share/session/authority suites and durable-share restart E2E |
| Export/import and crypto-erasure | ZIP/backup preserves nested bytes; stop/clear removes key material before records; revoked links fail | **PASS** — import/export, storage, workspace crypto/share suites and live revoke gates |
| Invalid/malicious invite or mailbox input | Noncanonical URLs, fragments, tier mismatch, wrong grant, forged signer, ciphertext swap, rollback, and cursor gaps fail closed without secret echo | **PASS** — browser invite/share/session/push/mailbox suites and Rust resolver/lifecycle suites |

## Route, viewport, and deployment matrix

| Environment | Result |
|---|---|
| Local Chromium hosted routes/share UI | **PASS** — focused Share sheet 7/7 and full web unit suite 78 files |
| Cloudflare staging | **PASS** — worker `fb0ebc57-8e38-4b12-8f97-e1dc79f45291`; full Playwright routes/authoring/offline/share/mobile/a11y 64/64 |
| Chromium + WebKit storage/reader suite | **PASS** — prior Phase 01/02 validation records; OPFS vs honest fallback and 320–430 px reader-first layouts |
| Current iPhone Safari normal/private/Home Screen | **DEVICE GATE** — attn-7xl.2.9 / ios-device-protocol.md |
| Current iPad Safari and Split View, 200% text, VoiceOver, dynamic chrome, Web Share/native handoff | **DEVICE GATE** — attn-7xl.7.6 / ios-device-protocol.md |
| Production `attn.sh` origin and rollback rehearsal | **HUMAN APPROVAL GATE** — attn-7xl.7.4 and .7.6; production was not changed during this matrix |
