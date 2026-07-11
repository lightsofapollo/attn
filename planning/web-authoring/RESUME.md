# Epic attn-7xl — resume handoff

Date: 2026-07-11
Branch: `main` (all work committed and pushed; tree clean)
Goal: complete Beads epic **attn-7xl** ("Ship browser-owned local workspaces
and sharing") via the `implement-bd` workflow — one ready child at a time,
following `planning/web-authoring/`, validating every frontend change with
Playwright, deploying + verifying Cloudflare staging.

**Hard gate (do not cross without asking the human):** do NOT perform the
production `attn.sh` cutover (attn-7xl.7 deploy of `web/wrangler.production.jsonc`
+ DNS). Everything else is in-scope.

## Where we are: 5 of 7 features done (71%)

| Feature | Status |
|---|---|
| attn-7xl.1 Unify landing/app/review routes | ✓ closed |
| attn-7xl.2 IndexedDB workspace storage v3 | ✓ closed (7.2.9 = human iOS device gate, open) |
| attn-7xl.3 Local browser authoring | ✓ closed |
| **attn-7xl.4 Browser-owned encrypted sharing** | ◐ **in progress — 4.1 & 4.2 done, 4.3–4.7 open** |
| attn-7xl.5 Accountless backup + storage controls | ✓ closed |
| attn-7xl.6 iOS Safari + offline hardening | ✓ closed |
| attn-7xl.7 Validate parity + cut over attn.sh | ○ open (final; human-gated) |

Run `bd show attn-7xl` and `bd list --parent attn-7xl.4` for live status.

## Resume point: attn-7xl.4.3 "Publish encrypted workspace snapshots"

This was in progress (research done, no code written yet). It is the next
ready child. **Nothing is claimed `in_progress` in bd right now** — claim
4.3 with `bd update attn-7xl.4.3 --status=in_progress` before starting.

### What 4.3 requires (from `planning/web-authoring/03-browser-sharing.md` Step 3)

Publish a share scope (current file / selected entries / whole workspace) as
encrypted per-file snapshots using the **exact native protocol** — do not
invent a web-only form. The native reference is `src/review/bootstrap.rs`
`publish_snapshot` (~line 1691) and `src/review/envelope.rs`
`assemble_snapshot_blob_envelope` (~line 420).

Per shared file, native does:
1. Build `SnapshotPlaintext { docType, content, anchorIndex? }`
   (`src/review/model.rs:244`), canonical-JSON it → `blob_bytes`.
   - `docType: markdown` → build the anchor index; `html` → no index.
2. `blob_hash = contentHash(blob_bytes)` (base64url SHA-256).
3. `snapshotId = derive_snapshot_id(roomId, fileId, baseHash, createdAtMs)`
   (`src/review/crypto/ids.rs:130` — `SHA-256("snapshot v2" || roomId ||
   fileId || baseHash || createdAtMs-decimal-ascii)[:16]`, base64url).
4. `clientNonce` = 16 random bytes; `envelopeId =
   derive_envelope_id_with_nonce(roomId, deviceId, clientNonce)`
   (`ids.rs:187` — `SHA-256("envelope v2" || roomId || deviceId ||
   clientNonce)[:16]`).
5. `assemble_snapshot_blob_envelope`: `kind: "snapshot_blob"`, AEAD-seal
   `blob_bytes` under `snapshotKey` with `EnvelopeAad {v,roomId,envelopeId,
   kind,authorId,deviceId,createdAt}`. **No embedded signature** —
   authenticity comes from the signed `SnapshotCreated` event that
   references it.
6. Threshold: if sealed ≤ mailbox cap → enqueue the blob envelope directly
   (mailbox lane); else → R2 lane: plaintext of the wrapper is the
   canonical-JSON `BlobRef`, and the sealed snapshot bytes
   (`seal_snapshot_r2_body`, `envelope.rs`) are PUT to a presigned R2 URL.
7. Emit a signed `SnapshotCreated` event (`ReviewEventBody`, wire type
   `snapshot_created`) with `fileId, snapshotId, ownerDisplayPath, baseHash,
   encryptedBlobRef` and `inlineSnapshot: null` (Decision #14 — never inline
   plaintext on the wire).

### Browser primitives that ALREADY exist (reuse, don't rebuild)

- `web/src/lib/review/browser-crypto.ts`: `aeadSeal`, `deriveEventId`,
  `deriveEventEnvelopeId` (event form), `signEvent`, `toCanonicalBytes`,
  `deriveRoomKeys`, `base64UrlEncode/Decode`, `sha256`. **Missing:
  `deriveEnvelopeIdWithNonce` (clientNonce form) and `deriveSnapshotId` —
  add them, mirroring `ids.rs`.**
- `web/src/lib/review/browser-envelope.ts`: `assembleBrowserEvent` (signed
  event + envelope) — use for the `SnapshotCreated` event. **Missing:
  `assembleSnapshotBlobEnvelope` — add it, mirroring `envelope.rs:420`.**
- `web/src/lib/review/browser-snapshot-r2.ts`: already OPENS native R2
  snapshots (`openWrapperBlobRef`, `parseR2BlobRef`, R2 body seal AAD). The
  reverse seal primitives are there to mirror for publishing.
- Types: `web/src/lib/types.ts` has `SnapshotCreatedBody`, `BlobRef`,
  `SnapshotPlaintext`-shaped `inlineSnapshot`, `AnchorIndex`, `DocType`.
- Anchor index: check `web/src/lib/review/anchors.ts` for a browser anchor
  indexer that matches `build_anchor_index`; if absent, that's a sub-task.

### The proven pattern for protocol correctness (USE THIS)

attn-7xl.4.1 established it: write unit tests that recompute every
byte/header from first principles, **AND** a live integration harness that
runs the real flow against the real relay under `wrangler dev` so the
relay's own verification is the referee. See:
- `web/scripts/test-owner-bootstrap-live.mjs` — copy this harness shape.
  Start relay with `--env staging --local --var
  QUOTA_ALLOW_UNATTRIBUTED_CREATES:true --var BLOB_CAP_SIGNING_KEY:...`
  (see `scripts/test-hosted-review-e2e.sh:88`).
- For 4.3, the strongest proof is: browser publishes a snapshot → a **native
  reviewer** (or the existing `BrowserSession` reviewer path) joins and
  decrypts it. That naturally becomes attn-7xl.4.6.

## Remaining attn-7xl.4 children (in dependency order)

- **4.3 Publish encrypted workspace snapshots** ← resume here
- **4.4 Run browser owner authority** — run the existing collab owner
  accept/reject/apply paths in the browser tab; when the owner tab is
  absent, comments/suggestions stay mailbox-capable while live editing shows
  paused. `BrowserSession` (`web/src/lib/review/browser-session.ts`) is the
  reviewer session today; owner authority extends it.
- **4.5 Build accountless Share sheet** — the Share UI shell already exists
  (`web/src/hosted/app/ShareSheet.svelte`) with the durability gate (4.5.4
  work from attn-7xl.5). Wire it to real `createOwnedRoom` + `bindShare` +
  snapshot publish; produce browser link, `attn://` native link, and CLI
  form from the same room secret; add stop-sharing + recreate-room.
  **Currently the sheet's "Copy browser link" is a stub.**
- **4.6 Verify native↔browser interoperability** — browser owner ↔ native
  reviewer and browser owner ↔ browser reviewer, incl nested Markdown, mixed
  assets, offline mailbox delivery, WebRTC direct proof.
- **4.7 Validate browser-owned encrypted sharing** — the feature validation
  gate; write `planning/web-authoring/validation-03.md` like the others.

## Building blocks delivered for attn-7xl.4 so far

- `web/src/lib/review/browser-owner-bootstrap.ts` (4.1): `createOwnedRoom`,
  `deleteOwnedRoom`, `defaultOwnerPolicy`, `inviteCapability`. Proven live.
- `web/src/lib/review/browser-crypto.ts::buildOwnerSignatureHeader` (4.1).
- `buildRegisterDeviceBody(identity, kind)` now takes `'reviewer'|'owner'`.
- `web/src/lib/review/browser-workspace-share.ts` (4.2):
  `WorkspaceShareStore` (via `BrowserStorage.shares`) — `bindShare`
  (seals invite capability under the workspace key), `openShare`,
  `setPublication` (pending→published→stopped), `listShares`, `forgetShare`,
  `inviteCapabilityFrom`.

## How to work (project conventions that bit me — follow them)

- **Always `cd web` first.** Unit tests run standalone via `tsx`:
  `npx tsx src/lib/review/<file>.test.ts`. Full suite: `npm test` (a custom
  runner, NOT vitest; each `*.test.ts` self-runs and `process.exit(1)`s on
  failure). `src/lib/review/browser-session.test.ts` is a KNOWN FLAKE under
  the parallel runner (filed as a bug) — re-run it standalone to confirm
  green; don't chase it.
- **Typecheck:** `npm run check` (svelte-check, must be 0 errors 0 warnings).
- **Bundle gate (CRITICAL):** `npm run check:route-bundles` after
  `build:browser`. The landing + app entries must NEVER statically import the
  editor/crypto graph — load crypto/storage via **dynamic import** (see
  `web/hosted/app/main.ts` loading `real-service.ts`). The gate matches
  module ids via `.vite/chunk-modules.json`, so page copy may say
  "ProseMirror" but the code may not be statically reachable.
- **Route/authoring e2e:** `npm run test:e2e:routes` (builds, runs the gate,
  then Playwright against the REAL Cloudflare worker via `wrangler dev`).
  Storage/reader e2e on Chromium **and** WebKit: `npm run test:e2e:storage`.
  Mock service scenarios: `?shell=demo|private|blocked|quota|empty`; no
  `?shell=` boots the real storage-backed service.
- **Deploy + verify staging** after each feature:
  `npm run deploy:staging` then
  `ATTN_ROUTES_BASE_URL=https://staging.attn.sh npx playwright test --config
  playwright.routes.config.ts`. Staging origin is `https://staging.attn.sh`,
  relay `https://relay-staging.attn.sh`.
- **Per task:** claim in bd (`in_progress`), implement, validate, `bd close`
  with a detailed reason, `git commit` (Co-Authored-By: Claude), `git push`.
  Beads auto-commits to Dolt via git hooks.
- No `any` types; no backwards-compat cruft (clean cutover); root-cause not
  hacks; verify empirically.

## Open human/device gates (cannot be automated; do not block on them)

- **attn-7xl.2.9** — real iOS Safari storage validation.
- Real-device iOS matrix in general → consolidated into **attn-7xl.7**.
- Protocol: `planning/web-authoring/ios-device-protocol.md`.

## Validation records already written (follow their format)

- `planning/web-authoring/validation-00.md` (routes/presence)
- `planning/web-authoring/validation-01.md` (storage v3)
- `planning/web-authoring/validation-02.md` (authoring)
- `planning/web-authoring/07-landing-cutover.md` (reversible cutover plan —
  prepared, NOT executed; `web/wrangler.production.jsonc` is deploy-gated on
  human approval)
