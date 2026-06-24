# Browser Live Collaboration Without TURN

Date: 2026-06-24
Status: planning deep dive
Scope: hosted browser version of attn review/live-collab, using WebRTC DataChannel with STUN only, relay mailbox for store-and-forward, and browser storage for local durability.

## Executive Summary

This is plausible on the web, but the product should not describe it as "guaranteed P2P" without TURN. Browser `RTCPeerConnection` plus `RTCDataChannel` can carry the same encrypted `MailboxEnvelope` bytes the native Rust transport already sends over webrtc-rs. The browser does not need a port of `src/review/transport/webrtc.rs`; it needs a TypeScript implementation of the same protocol decisions around signaling, envelope assembly, inbound validation, and mode selection.

The right browser default is hybrid:

- Durable path: relay mailbox via `POST /v2/rooms/:roomId/envelopes` plus WebSocket replay, so offline recipients still receive events later.
- Fast path: STUN-only WebRTC DataChannel when ICE succeeds.
- Degraded path: stay on the mailbox if direct P2P fails. Surface `direct_failed` or `mailbox`, not a silent "live" success.

Without TURN, direct P2P will fail on some networks, especially symmetric NATs, restrictive corporate networks, captive portals, and UDP-blocking environments. The relay can still deliver durable review events and co-typing signals, but latency will be mailbox/WebSocket latency instead of DataChannel latency. That is acceptable for comments, suggestions, snapshots, and light co-typing; it is not equivalent to a guaranteed low-latency native live session.

Cost is low if TURN stays out of scope. Direct DataChannel bytes do not touch attn infrastructure. Relay cost is mainly Cloudflare Workers/Durable Objects requests, WebSocket activity, DO storage rows, and R2 snapshot storage/ops. Early usage should fit around the Workers paid minimum, with R2 likely free or pennies unless snapshot volume grows. TURN cost is zero by decision, not because TURN is free.

Browser storage is useful and should be part of the plan, but it changes the product contract:

- Browser can queue local outgoing work while the tab is open or after reload.
- Browser can resume rooms after reload if we persist identity, cursor, event log, and snapshots.
- Browser cannot keep WebRTC alive after the tab/app is closed.
- Browser cannot reliably send while fully closed; service workers are not a core transport for live RTC.
- Browser storage can be evicted unless persistence is granted and the user does not clear site data.

## What "Offline Transfer" Can Mean On Web

There are three different offline cases:

1. Recipient offline: supported by mailbox. The sender posts encrypted envelopes to relay storage; recipient replays from `afterSeq` later.
2. Sender temporarily disconnected but tab still open: supported by browser outbox. Queue envelopes in IndexedDB, retry when the network returns.
3. Sender closed the browser: not reliably supported. We can persist the outbox and send next time the user opens attn, but we should not promise closed-tab delivery.

Native can keep a daemon alive. A hosted browser cannot. A PWA/service worker can improve app shell caching and maybe opportunistic background sync, but it should not be the correctness path for review delivery.

## Existing Native Transport Model

The native architecture is already the right model to copy.

`src/review/transport/selector.rs:1-21` defines the product modes:

- Live uses WebRTC only and explicitly fails when direct transport is unavailable.
- Async uses mailbox only.
- Hybrid uses both, with mailbox as the always-on durable outbox and WebRTC as the low-latency path.

`src/review/transport/selector.rs:381-430` implements that behavior. The key browser-relevant invariant is in hybrid mode: post to mailbox first, then try WebRTC best-effort if connected. If WebRTC fails after mailbox accepts the envelopes, the operation still succeeds because the relay has durable bytes and receivers dedupe later.

`src/review/transport/webrtc.rs:1-24` establishes the critical wire decision: WebRTC DataChannel uses the same encrypted `MailboxEnvelope` format as the mailbox. The DataChannel changes the byte path, not the payload shape. This is what makes browser/native interoperability realistic.

`src/review/transport/webrtc.rs:60-64` shows the current native default is STUN-only (`stun:stun.l.google.com:19302`). `WebRtcConfig` allows TURN-shaped ICE servers in the same list (`src/review/transport/webrtc.rs:111-114`), but the shipped default is not TURN.

`src/review/transport/webrtc.rs:507-548` creates the DataChannel before the offer and publishes an encrypted `SignalingPayload::Offer` into the signal lane. `src/review/transport/webrtc.rs:550-619` handles offer, answer, and trickle ICE. Browser code should mirror this with `RTCPeerConnection.createDataChannel`, `createOffer`, `setLocalDescription`, `setRemoteDescription`, `createAnswer`, and `addIceCandidate`.

`src/review/transport/webrtc.rs:655-680` serializes an already encrypted `MailboxEnvelope` to JSON bytes and sends it over the DataChannel. Browser should do the same with `TextEncoder(JSON.stringify(envelope))` or canonical JSON if the envelope object needs stable ordering for tests. The encryption/signature invariants live inside the envelope, not in the DataChannel.

`src/review/transport/webrtc.rs:999-1098` routes inbound DataChannel bytes through the same inbound pipeline as mailbox. Event envelopes produce `EventImported`; snapshot envelopes persist/import; signal envelopes are decoded only if they are `SignalingPayload::Collab`. SDP/ICE should stay on the relay signal lane, while high-frequency co-typing can ride DataChannel when available.

`src/review/transport/signaling.rs:1-56` defines encrypted signal envelopes. The relay only sees cleartext routing metadata and the optional `target.deviceId`; SDP, ICE, request-snapshot, and collab payloads are sealed under `signalingKey`.

`src/review/transport/signaling.rs:74-119` is the plaintext signal enum:

- `offer`
- `answer`
- `ice`
- `request_snapshot`
- `collab`

`src/review/transport/signaling.rs:147-212` assembles a `kind: "signal"` `MailboxEnvelope`. This is the browser implementation target for a new `browser-signaling.ts`.

`src/review/transport/inbound.rs:1-32` documents the transport-agnostic inbound pipeline. `src/review/transport/inbound.rs:341-393` is especially important: signal `target.deviceId` is not AAD-bound, so receivers must reject signals addressed to another device before decrypting. Browser currently lacks this anti-redirect check and must add it before signal dispatch.

`src/review/manager.rs:1803-1918` already builds one native WebRTC transport per remote peer and maps aggregate connection state to `live_direct` only when all peer DataChannels are connected; otherwise the badge falls back to `mailbox`.

`src/review/manager.rs:2294-2359` and `src/review/manager.rs:2470-2507` show the snapshot recovery behavior: prefer WebRTC when connected, fall back to mailbox. The browser plan should reuse that same hierarchy.

## Existing Browser Surface

The browser review client already has the first half of the stack.

`web/src/lib/review/browser-session.ts:1-34` says the current browser session is reviewer-only and intentionally leaves out outbound authoring, snapshot R2 download, and cursor persistence. Those are prerequisites before live RTC can be reliable.

`web/src/lib/review/browser-session.ts:486-520` registers an in-memory browser device through `POST /devices` with admission HMAC. `web/src/lib/review/browser-session.ts:522-556` opens the WebSocket with admission in `Sec-WebSocket-Protocol`. It currently starts with `afterSeq: 0`, so reload always replays from the beginning instead of a persisted cursor.

`web/src/lib/review/browser-session.ts:562-599` imports event envelopes into the UI and deliberately ignores signal envelopes. Browser live work starts by replacing that final "signals out of scope" branch with signal parse, anti-redirect, WebRTC control-plane routing, and collab routing.

`web/src/lib/review/browser-ws.ts:1-23` mirrors the Rust mailbox WebSocket receive path. It connects, maintains a device cache, decrypts/verifies inbound envelopes, reconnects, and maps terminal close codes. It deliberately does not sign outbound events, persist cursors, or download R2 snapshot blobs.

`web/src/lib/review/browser-ws.ts:454-514` already picks the AEAD key by envelope kind, reconstructs AAD, opens the ciphertext, verifies event signatures, and advances an in-memory cursor. The missing browser parity is persistence and signal target validation before exposing signal plaintext.

`web/src/lib/review/browser-crypto.ts:1-18` documents the decision to use TypeScript plus `@noble/*` rather than WASM. `web/src/lib/review/browser-crypto.ts:190-239` derives the same `eventKey`, `snapshotKey`, `signalingKey`, and `admissionKey` as Rust. `web/src/lib/review/browser-crypto.ts:254-334` implements XChaCha20-Poly1305 seal/open with the same AAD shape. This means signal/event assembly can be implemented in TypeScript without porting Rust crypto.

`web/src/App.svelte:351-377` already defines when live co-typing is active. It treats any non-`offline` connection as a usable step path, including mailbox fallback.

`web/src/App.svelte:569-604` constructs `CollabController` with `send: (payload) => reviewCollabSend(roomId, payload)`. In native, that goes through IPC to Rust. In hosted browser, this send function needs to be injected from `BrowserSession` or a browser review transport.

`web/src/lib/ipc.ts:208-215` shows `reviewCollabSend` is just a Wry IPC wrapper. For browser builds, route the same opaque payload through browser signaling/DataChannel instead.

`web/src/lib/prosemirror/collab-controller.ts:1-13` is already transport-free. `web/src/lib/prosemirror/collab-controller.ts:55-62` defines the wire messages as JSON strings carried inside `SignalingPayload::Collab`. `web/src/lib/prosemirror/collab-controller.ts:251-328` routes inbound submit, broadcast, resync, and cursor messages. This is usable as-is if the browser provides a compatible send/receive signal pipe.

`web/src/lib/prosemirror/collab-session.ts:1-15` confirms the lower collab client/host layer is DOM-free and wire-injected, so it does not care whether messages came from mailbox or RTCDataChannel.

`web/src/lib/types.ts:922-974` already has the desired UI connection union: `live_direct | mailbox | offline | direct_failed`. Browser live should reuse this instead of inventing new states.

## Existing Relay Surface

The relay is also close to ready for browser live.

`relay/src/schema.ts:37-50` has `policy.allowBrowser`, defaulting to false. Browser rooms must opt in.

`relay/src/schema.ts:95-103` accepts device registrations with `client: "attn-browser"`.

`relay/src/schema.ts:117-163` supports envelope batches with `kind: "event" | "snapshot_blob" | "signal"` and optional/null `target`. This already covers browser signaling and collab payloads.

`relay/src/index.ts:57-77` defines the internal allow-browser header and CORS allowed headers/methods. `relay/src/index.ts:291-310` forwards WebSocket upgrades to the RoomDO and lets the DO enforce browser Origin policy.

`relay/src/index.ts:313-325` currently notes that blob routes skip CORS. Browser snapshot R2 support will need this fixed or mediated, otherwise hosted browser clients cannot reliably fetch/upload blob spillovers cross-origin.

`relay/src/room-do.ts:921-1273` handles `POST /envelopes`: admission, PoW, schema validation, size caps, device registration checks, idempotency, storage, signal sub-cap, and live WS broadcast.

`relay/src/room-do.ts:1198-1205` stores a per-target index for targeted signal envelopes. `relay/src/room-do.ts:1258-1265` broadcasts fresh envelopes to live sockets after commit.

`relay/src/room-do.ts:2039-2235` handles WebSocket upgrades. `relay/src/room-do.ts:2082-2108` enforces `policy.allowBrowser` and `ALLOWED_BROWSER_ORIGINS` when the request has an `Origin` header.

`relay/src/room-do.ts:2316-2382` sends `hello`, device list, missed signal ids, and replay frames. It filters replay by signal target.

`relay/src/room-do.ts:2384-2419` broadcasts fresh envelopes only to deliverable sockets. `relay/src/room-do.ts:3212-3226` defines deliverability: targeted signal to the target device only, broadcast signal to everyone, all other kinds to everyone.

`relay/test/integration/cors.test.ts:1-23` covers browser CORS and WS Origin rules. `relay/test/integration/websocket.test.ts:429-455` captures the `hello`, `envelope`, `error`, `presence`, and `ping` frame shapes. `relay/test/integration/websocket.test.ts:675-711` covers targeted signal delivery.

## Proposed Browser Architecture

Add a browser-side transport layer that mirrors native mode selection but is built around browser APIs.

Suggested modules:

- `web/src/lib/review/browser-storage.ts`
  - IndexedDB schema and migrations.
  - OPFS helpers for snapshot/workspace blobs.
  - `navigator.storage.persist()` and `navigator.storage.estimate()` wrappers.

- `web/src/lib/review/browser-outbox.ts`
  - Assemble event/snapshot/signal `MailboxEnvelope`s.
  - Persist queued outbound envelopes in IndexedDB.
  - Mint PoW in a Worker.
  - POST batches to `/v2/rooms/:roomId/envelopes`.
  - Record accepted `serverSeq`s and retry idempotently.

- `web/src/lib/review/browser-signaling.ts`
  - TypeScript mirror of `SignalingPayload`.
  - `assembleSignalEnvelope(...)` equivalent to Rust `assemble_signal_envelope`.
  - `openSignalEnvelope(...)` with target check before decrypt.
  - Dispatch offer/answer/ice/request_snapshot/collab.

- `web/src/lib/review/browser-webrtc.ts`
  - One `RTCPeerConnection` per remote device.
  - STUN-only ICE servers by default.
  - DataChannel label `attn-review`.
  - Send/receive `MailboxEnvelope` JSON bytes.
  - Map connection states to `live_direct`, `mailbox`, `direct_failed`.

- `web/src/lib/review/browser-live-transport.ts`
  - Owns the mode logic.
  - Uses mailbox first in hybrid, direct RTC best-effort second.
  - Exposes `sendEvent`, `sendSnapshot`, `sendSignal`, and `sendCollab`.
  - Emits store updates matching `window.__attn__` native callbacks.

The browser does not need to port the native Rust WebRTC implementation. Browser WebRTC must use `RTCPeerConnection`; the native Rust file is a protocol reference. Porting Rust to WASM would add build/runtime complexity while still lacking raw UDP/socket control and while duplicating the browser's WebRTC stack.

The browser also does not need a Rust server for P2P. A server can signal, store, and relay. Without TURN, it cannot make every pair of browsers directly reachable; only ICE plus STUN can do that when the networks allow it.

## Connection Flow

Initial join:

1. Parse invite and derive keys from `roomSecret`.
2. Load or create browser device identity.
3. Register device via `POST /devices`.
4. Open WebSocket with persisted `afterSeq`.
5. On `hello`, update roster and device cache.
6. Start WebRTC negotiation with each eligible remote device if room mode is live/hybrid.
7. Keep mailbox as active connection state until every required DataChannel is open.

Signaling:

1. Initiator creates `RTCPeerConnection` and DataChannel.
2. Initiator creates SDP offer and sends `SignalingPayload { kind: "offer" }` as a targeted signal envelope via browser outbox.
3. Responder opens targeted signal envelope only if `target.deviceId` is self.
4. Responder applies offer, creates answer, sends targeted answer.
5. Both sides send trickle ICE as targeted signal envelopes.
6. DataChannel open changes per-peer direct state.

Data channel:

1. Event/snapshot envelopes remain AEAD sealed exactly as mailbox envelopes.
2. Browser sends JSON `MailboxEnvelope` bytes on `attn-review`.
3. Receiver parses JSON, validates envelope kind, and imports through the same browser crypto pipeline used by WebSocket.
4. For `signal` envelopes over DataChannel, only `collab` should route to `CollabController`. SDP/ICE remains relay signal control-plane.

Hybrid send:

1. Persist/send to mailbox first.
2. If DataChannel is open, send the same envelope over RTC best-effort.
3. Receiver dedupes event IDs and envelope IDs.
4. Return success from mailbox ack, not from DataChannel ack.

Live-only send:

1. Only allow once DataChannel is open.
2. If STUN-only direct connection fails, surface `ATTN_LIVE_REQUIRED` or browser equivalent and do not silently use mailbox.
3. Product recommendation: avoid live-only as the first browser shipping mode. Prefer hybrid with direct badge.

## Browser Storage Plan

Use three web storage layers:

- IndexedDB for structured durable state:
  - room records
  - device identity and public/private signing keys if the user opts into remembered rooms
  - device directory cache
  - last imported `serverSeq`
  - event metadata and imported event bodies
  - outbound envelope outbox
  - sent-envelope ack log
  - pending signal retries
  - peer connection state diagnostics

- OPFS for larger file/blob content:
  - snapshot plaintext/cache by room/file/snapshot
  - encrypted downloaded R2 blobs if useful
  - browser-owned workspace file contents
  - draft/co-typing recovery buffers

- Cache Storage for app shell and static assets through a service worker.

Persistence policy:

- Call `navigator.storage.persist()` after the user joins or creates a durable room.
- Show a degraded/offline warning only if persistence is denied and the room has unsent local work or large cached snapshots.
- Use `navigator.storage.estimate()` to display storage pressure and prune older rooms/snapshots.
- Keep localStorage/sessionStorage out of the data path; they are synchronous and too small for this workload.

Secret policy:

- Default safest mode: keep `roomSecret` and derived room keys memory-only. Reload requires invite re-entry, but leaked browser storage does not expose old room contents.
- Usable mode: "Remember this room" stores device identity, cursor, and enough key material to rejoin. This must be explicit because anyone with the browser profile can re-open the room.
- If keys are stored, prefer IndexedDB. WebCrypto non-extractable CryptoKeys are helpful for signing, but the existing noble Ed25519 path uses raw keys, so this needs a deliberate migration if we want non-extractable keys.
- Never store room secrets in URL, localStorage, cookies, or service worker cache.

File/workspace policy:

- OPFS is the cross-browser private workspace for browser-owned files.
- File System Access API can be a progressive enhancement for Chromium-style local directory write-back, with explicit user permission.
- Non-supporting browsers use import/export/download and OPFS-backed workspaces.

## Cost Model Without TURN

As of 2026-06-24, official Cloudflare docs show:

- Workers Standard: 10M requests/month included, then $0.30 per million; 30M CPU ms/month included, then $0.02 per million CPU ms. WebSocket upgrades count as Worker requests, but WebSocket messages routed through a Worker do not count as Worker requests.
- Workers paid examples use a $5/month subscription/minimum.
- Durable Objects: storage-backed requests and WebSocket activity are billable, but the examples show hibernation materially reducing duration cost. DO SQLite storage includes large row-read/write allowances and 5 GB-month stored data before overage.
- R2 Standard: $0.015/GB-month, $4.50/million Class A operations, $0.36/million Class B operations, 10 GB-month and large operation allowances in the free tier, and no egress charge.
- Cloudflare Realtime TURN: $0.05/GB after a 1,000 GB free tier, while STUN at `stun.cloudflare.com` is free and unlimited. This plan does not use TURN, so TURN line-item cost is $0.

What costs money:

- Room creation and device registration HTTP requests.
- Envelope POSTs for events, snapshots, and signaling.
- WebSocket upgrades and Durable Object WebSocket message processing.
- DO row reads/writes for room metadata, devices, envelopes, indexes, acks, and signal sub-cap eviction.
- R2 storage and operations for snapshot blobs above inline threshold.

What does not cost attn relay bandwidth:

- Direct RTCDataChannel event/collab bytes when STUN succeeds.
- Browser-to-browser encrypted media/data after ICE establishes a direct candidate pair.

Rough early-stage expectation:

- Small private beta with mostly text review events and modest snapshots should sit near the Workers paid minimum plus negligible R2/DO overage.
- A heavy live-collab room that cannot connect P2P will push high-frequency collab over relay signal envelopes. That costs DO requests/messages/storage and can bloat the signal lane. Rate-limit/coalesce cursor traffic and prefer DataChannel when available.
- Snapshot-heavy usage is the first likely R2 driver, but R2 is cheap and has free monthly allowance. The bigger risk is abuse and retained data, not normal markdown review traffic.

## Performance And UX Expectations

Expected browser behavior without TURN:

- Same-network and normal home networks: often direct P2P works.
- Mobile tethering, CGNAT, campus/corporate networks, VPNs, UDP-blocked environments: direct P2P may fail.
- If direct P2P fails, comments/suggestions/snapshots still work over mailbox.
- Co-typing can continue over relay signals, but latency and ordering gaps will feel worse than direct DataChannel.
- Large data transfer should use snapshot/blob envelopes and OPFS/R2, not DataChannel as a file-transfer tunnel in the first release.

UI contract:

- Show `mailbox` while connected to relay.
- Show `live_direct` only when required peer DataChannels are open.
- Show `direct_failed` when STUN-only WebRTC fails but mailbox remains available.
- Do not label mailbox fallback as P2P.

## Security Notes

Keep these invariants:

- DataChannel payloads remain encrypted envelopes. Do not send plaintext collab steps directly on RTC.
- Signal target anti-redirect is mandatory in browser before decrypt.
- The relay can route and store ciphertext, but should not see SDP/ICE plaintext because signal envelopes are sealed under `signalingKey`.
- Browser origin allowlisting must remain room-policy gated through `allowBrowser`.
- Stored browser secrets require an explicit UX decision.
- Device self-signature and PoW must be real before enabling browser authoring or signaling writes.

Signal AAD caveat:

`target.deviceId` is not AAD-bound by design in Rust (`src/review/transport/signaling.rs:170-177` and `src/review/transport/inbound.rs:350-360`). That is acceptable only if every receiver repeats the target check before decrypt. Browser must not rely only on relay filtering.

## Implementation Plan

Phase 0 - prerequisites:

- Replace browser PoW placeholder in `browser-session.ts` with a Web Worker miner.
- Add persisted `afterSeq` and reconnect cursor management to `BrowserWsClient`.
- Add browser outbound envelope signing/sealing for events and signals.
- Add browser outbox POST path with admission HMAC and PoW.
- Add R2 blob CORS/presign browser support or a same-origin browser relay proxy.

Phase 1 - browser storage foundation:

- Add `browser-storage.ts` using IndexedDB for room/cursor/device/outbox/event state.
- Add OPFS helpers for snapshots and browser-owned workspace files.
- Add storage persistence request and quota/usage telemetry.
- Add migration tests and reload recovery tests.

Phase 2 - mailbox parity:

- Persist imported events and snapshots, not just in-memory `reviewStore`.
- Persist `afterSeq` after successful import.
- Implement snapshot blob download for `BlobRef storage: "r2"`.
- Implement browser event authoring and suggestions through the new outbox.

Phase 3 - signaling parity:

- Add `browser-signaling.ts` with signal payload types and assemble/open helpers.
- Implement `offer`, `answer`, `ice`, `request_snapshot`, and `collab` parsing.
- Add anti-redirect target validation before decrypting signals.
- Route `collab` payloads into the same callback shape as native `ReviewCollabSignal`.

Phase 4 - STUN-only browser WebRTC:

- Add `browser-webrtc.ts`.
- Use STUN-only ICE servers. Prefer a config value; candidates are `stun:stun.cloudflare.com:3478` or the existing native Google default for parity.
- One connection per remote device.
- DataChannel label: `attn-review`.
- Send encrypted `MailboxEnvelope` JSON bytes.
- Keep SDP/ICE on relay signal lane.
- Implement reconnect and bounded retry similar to native ICE restart policy.

Phase 5 - collab integration:

- Replace hosted-browser `reviewCollabSend` IPC path with a transport-injected send function.
- Send collab as `SignalingPayload::Collab`.
- In hybrid:
  - if DataChannel open, send collab over DataChannel signal envelope or direct encrypted signal envelope bytes;
  - otherwise send via relay signal envelope.
- Continue to drop self-echoes.
- Coalesce cursor updates to avoid relay flood when on mailbox fallback.

Phase 6 - UX and policy:

- Add clear connection badge states for `mailbox`, `live_direct`, `direct_failed`, and `offline`.
- For browser-created rooms, default to `hybrid` and `allowBrowser: true`.
- Hide/disable live-only browser mode until STUN-only failure UX is acceptable.
- Add an explicit "remember this room" decision if persistent key storage is implemented.

Phase 7 - tests:

- TS unit tests for signal envelope assembly/open against Rust test vectors.
- Browser signal anti-redirect tests.
- Browser outbox idempotency tests.
- Browser storage reload tests for cursor/event/snapshot recovery.
- Relay integration tests for CORS on blob routes.
- Playwright browser-to-browser happy path with local two-tab DataChannel.
- Native-to-browser interoperability test for offer/answer/ICE and DataChannel envelope import.
- STUN failure simulation that verifies mailbox fallback and `direct_failed`.

## Open Decisions

- Should browser v1 support browser owner, browser reviewer only, or both?
- Should browser persist room keys by default, ask with "remember this room", or remain memory-only?
- Should STUN server default be Cloudflare (`stun:stun.cloudflare.com:3478`) for cost/vendor alignment or Google for native parity?
- Should live-only mode be disabled in hosted browser until TURN is available?
- Should co-typing over mailbox fallback be enabled by default, or should relay fallback carry only durable review events and cursor-light collab?
- Should browser DataChannel send `signal/collab` envelopes only, or all event/snapshot envelopes like native hybrid?
- What is the max browser room peer count before mesh complexity becomes unacceptable? Current relay policy caps `maxPeers` at 8, but browser mesh should likely start lower.

## Main Risks

- STUN-only reachability is not under our control. Some networks will not produce a direct path.
- Browser lifecycle is weaker than native. Closing the tab ends live RTC and pauses outbox draining.
- Browser storage is origin-scoped and can be cleared by users or evicted under pressure.
- Persisting room secrets improves UX but weakens the "invite fragment only" security story.
- Co-typing over relay fallback can become noisy. Cursor traffic needs rate limiting.
- Multi-peer mesh grows quickly. One DataChannel per remote device is fine for small rooms, not large group editing.
- Blob routes currently skip CORS, which blocks full browser snapshot parity until fixed.

## Recommendation

Ship browser live as "hybrid-first, STUN-only direct acceleration":

1. Finish browser mailbox durability and outbox.
2. Add browser signal parsing and anti-redirect.
3. Add STUN-only RTCDataChannel as an opportunistic fast path.
4. Keep all durable review data on mailbox and all large snapshots on R2/OPFS.
5. Show direct P2P honestly: `live_direct` when connected, `mailbox` or `direct_failed` otherwise.

This gives browser users most of attn's live value at low infra cost, without the surprise bills or operational surface of TURN. It does not give guaranteed P2P across every network. If product requirements later demand "live always works", TURN or a relay-equivalent data plane becomes necessary.

## Sources Checked

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Realtime TURN FAQ: https://developers.cloudflare.com/realtime/turn/faq/
- MDN storage quotas and eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- MDN StorageManager.persist: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- web.dev storage guidance: https://web.dev/articles/storage-for-the-web
- MDN WebRTC API: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- MDN File System API / OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
