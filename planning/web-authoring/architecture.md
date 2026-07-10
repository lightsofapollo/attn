# Architecture

## 1. Hosted surface and landing integration

Today `site/` is a SvelteKit static marketing site deployed separately, while
`web/hosted` is a Vite/Cloudflare SPA containing the real browser E2EE client.
Keeping them on separate origins would split IndexedDB, OPFS, persistence
grants, installed-PWA identity, and remembered rooms. The target is one
Cloudflare origin and one security policy.

Use the existing `web` package as the canonical hosted implementation because
it already owns the audited browser crypto, outbox, storage, WebRTC, editor, and
review components. Build three lazy, route-specific entries:

- `/` → landing bundle
- `/app/*` → local-workspace bundle
- `/review/*` → existing review bundle

The Cloudflare worker maps deep paths to the appropriate HTML entry. Shared
fonts/tokens can be common chunks; editor, Mermaid, KaTeX, and crypto code must
not inflate the landing bundle. Migrate the best `site/src/lib` marketing
components into `web/src/hosted/landing`, then retire the Vercel deployment only
after visual/content parity and redirects are verified.

This is deliberately not a SvelteKit migration of the product app. The current
Vite build and Svelte 5 client architecture already work under the strict
static-worker CSP. A future prerender step may emit landing HTML for SEO, but it
must not introduce SSR state or a second application implementation.

## 2. Data model: workspace is not room

A **workspace** is browser-local authoring state. A **room** is an encrypted,
TTL-bound sharing session. They have separate identifiers and lifecycles.

```text
BrowserWorkspace
  workspaceId
  title
  createdAt / updatedAt / lastOpenedAt
  currentFileId
  storageMode: persistent | best_effort | volatile
  files[]
  shares[] -> roomId + invite capability + publish state

WorkspaceEntry
  workspaceId + fileId
  displayPath
  kind: markdown | asset
  mediaType
  headRevisionId
  createdAt / updatedAt

BrowserRevision
  workspaceId + fileId + revisionId
  parentRevisionId?
  contentHash
  byteLength
  storage: idb | opfs
  encryptedBody or encryptedPath
```

Markdown entries are editable. Asset entries preserve arbitrary bytes and
relative paths, but inline rendering is allowlisted (initially PNG, JPEG, GIF,
WebP, and AVIF). SVG and other active or unknown formats are download-only
unless a separately sandboxed sanitizer/renderer is introduced. Decrypted
previews use short-lived object URLs that are revoked on replacement/teardown.

One workspace may publish multiple successive rooms over its life. Deleting or
expiring a room must not delete the local workspace. Deleting the workspace
must prompt separately about live rooms.

## 3. Storage stack

### IndexedDB — required source of durable truth

Extend `attn-browser-review` from schema v2 to v3 rather than creating another
database. Add stores for:

- `workspaces`
- `workspace_keys`
- `workspace_files`
- `workspace_revisions`
- `workspace_shares`
- `workspace_recovery`
- `workspace_gc`

Keep existing room/device/inbox/cursor/outbox/history stores unchanged. All
schema upgrades run in the IndexedDB upgrade transaction and are covered by
old-version fixtures.

IndexedDB stores metadata and encrypted small revision bodies. It remains a
complete fallback when OPFS is absent. Structured operations such as “create
file + first revision + select file” and “advance head + enqueue share snapshot”
must be atomic IndexedDB transactions.

### OPFS — encrypted large-body tier

Use OPFS above an initially conservative threshold (256 KiB) for encrypted
Markdown revisions and binary asset bodies. Paths contain only opaque hashes:

```text
attn/workspaces/<workspace-hash>/revisions/<revision-hash>.bin
attn/workspaces/<workspace-hash>/tmp/<write-id>.bin
```

Cross-store commit protocol:

1. Seal bytes in memory.
2. Write and close an OPFS temp file.
3. Atomically commit the revision metadata/head pointer in IndexedDB.
4. Rename/promote where supported, otherwise treat the immutable temp hash as
   the final path.
5. Queue orphan cleanup in `workspace_gc` after crashes or aborted IDB commits.

When OPFS is unavailable or fails, store the encrypted body as an IndexedDB
Blob/ArrayBuffer. The user never sees a browser-support dead end for normal
Markdown-sized files.

### Cache Storage — application code only

A service worker may cache hashed application assets for offline launch.
Navigation HTML is network-first with a verified last-known shell fallback.
Never cache `/v2`, `/review/*#key`, request bodies, room responses, document
content, recovery exports, or capability-bearing R2 URLs.

Do not use `localStorage` or cookies for application state.

## 4. Local key hierarchy

On workspace creation:

1. Generate a random 32-byte workspace root.
2. Import it as a non-extractable HKDF `CryptoKey` and structured-clone that key
   into `workspace_keys`.
3. Derive domain-separated local content, metadata, share-capability, and
   identity-wrapping keys.
4. Seal every stored revision body and private identity payload before writing.
5. Zero transient raw key bytes.

On room creation, the raw room secret is needed later to reproduce invite
links. Seal it as an `invite capability` under the workspace share-capability
key before zeroing it. The non-extractable root can later derive the unwrap key;
the raw invite secret never appears directly in IndexedDB.

This protects at-rest database inspection and casual backup extraction. It does
not protect against malicious same-origin JavaScript or an unlocked compromised
browser profile. That limitation belongs in security documentation and user
copy.

## 5. Recovery without accounts

There is no server-side key escrow and no account recovery. Recovery has two
layers:

- **Content backup:** export a normal Markdown folder/zip. This is the primary,
  comprehensible recovery path and works on iOS through the Files share sheet.
- **Share continuity:** persist the wrapped invite capability and encrypted
  owner identity locally so the same browser profile can recopy links and
  resume authority. If site data is lost, the user can import the Markdown
  backup and create a new room; old room ownership is not recoverable in v1.

Do not invent mnemonic keys or password-based recovery until there is a clear
cross-device ownership-transfer product. A weak or forgotten passphrase would
create worse expectations than a direct Markdown export.

## 6. Browser-owner room bootstrap

Add a browser counterpart to native `ReviewBootstrap::share` that reuses the
same protocol shapes:

1. Generate room secret, derive room ID and subkeys.
2. Generate/persist the owner Ed25519/X25519 device identity.
3. Create the room with `allowBrowser: true`, `mode: hybrid`, and bounded TTL.
4. Sign/register the owner device.
5. Emit `RoomCreated` and owner `ParticipantJoined` envelopes.
6. Publish a manifest and the selected Markdown/assets snapshot
   (inline/mailbox/R2 by size), preserving relative paths and content hashes.
7. Open mailbox/WebRTC transports through `BrowserSession`.
8. Return three invite forms from the same secret:
   - `https://attn.sh/review/<roomId>#key=…`
   - `attn://review/<roomId>#key=…`
   - `npx attnmd review join 'attn://…'`

Browser owner authority is active only while an owner tab is running. When the
owner is offline, durable comments/suggestions still queue through the mailbox,
but co-typing and owner-only accept/reject are shown as paused—not silently
pretended to be live.

The share scope is explicit: current file, selected entries, or whole
workspace. The canonical snapshot manifest is shared by browser and native and
contains normalized relative paths, media types, byte lengths, and content
hashes—but never local OPFS paths. A Markdown file's relative image references
resolve only to entries present in that manifest. Missing assets render an
honest placeholder rather than fetching an arbitrary network URL.

## 7. Concurrency and autosave

- Use IndexedDB read/write transactions as the cross-tab serialization source;
  do not require Web Locks because Safari Lockdown Mode may disable it.
- Add a per-workspace lease with fencing token and heartbeat. Only the lease
  holder writes ProseMirror/autosave revisions; other tabs open read-only with
  an explicit “Take over editing” action.
- BroadcastChannel is an optimization for prompt UI updates, never the source
  of correctness.
- Debounce editor persistence (target 300–500 ms), but flush on visibility loss
  and pagehide. Every revision is immutable; advancing `headRevisionId` is the
  atomic commit.
- Never rely on unload handlers, background sync, or a service worker to finish
  room publication.

## 8. iOS Safari contract

The product contract is reader-first. Existing local or shared workspaces open
in a full document reader; editing is an explicit capability, not a prerequisite
for mobile usefulness. File navigation, safe asset viewing, anchored review,
export, and native handoff are independently capability-gated. See
`ios-ux.md` for the interaction and accessibility contract.

Capability-test the actual operations at startup:

1. Open/migrate IndexedDB and round-trip a temporary record.
2. Structured-clone a non-extractable `CryptoKey`.
3. Probe OPFS directory/create/read/write/delete.
4. Query `navigator.storage.estimate()` and `persisted()` when present.
5. Request persistence only from a user gesture such as “Keep on this device.”

Modes:

- `persistent`: full authoring/sharing.
- `best_effort`: authoring works; show backup/persistence warning before share.
- `volatile`: current-tab scratch editing/import/export only; share disabled
  until local durability succeeds or risk is explicitly accepted for a
  disposable room.
- `unsupported`: IndexedDB/WebCrypto failed; review-only may still work in
  memory, but local authoring is unavailable with precise remediation copy.

Safari Private Browsing must use the IndexedDB fallback and clearly state that
work can disappear when the private session closes. Lockdown Mode failures are
handled as missing capabilities, not as “Safari unsupported.”

## 9. Threat boundaries

- Strict same-origin deployment; no user content in third-party origins.
- No analytics, tag managers, ad scripts, remote fonts, or runtime CDN imports.
- CSP stays deny-by-default and pins relay HTTPS/WSS origins.
- Trusted Types adoption is a desirable hardening item now that Safari 26
  supports it, but does not replace current Svelte escaping/sanitization.
- Every imported file/path is untrusted. Normalize display paths, cap each file
  and the total workspace, reject traversal, sniff/validate media rather than
  trusting extensions, and parse Markdown without executing HTML. Never render
  an imported active document as same-origin content.
- Recovery exports and share links must be excluded from logs, traces, crash
  reports, referrers, recent-search UI, and service-worker caches.

## 10. Test strategy

- Fake IndexedDB unit/migration/property tests for every transaction invariant.
- OPFS contract tests against a fake plus real Chromium/WebKit browser tests.
- Playwright local and staging tests for create → reload → edit → share → join
  from second browser and native owner/reviewer.
- WebKit project in Playwright for broad compatibility, plus real-device Safari
  runs on current iPhone and iPad because Playwright WebKit is not iOS Safari.
- Storage pressure/failure injection for `QuotaExceededError`, aborted OPFS
  writes, blocked migrations, denied persistence, and tab lease takeover.
- Mixed-workspace interop fixtures containing nested Markdown, duplicate
  basenames, raster images, unknown binary assets, missing references, and R2
  spillover; web/native must preserve the same manifest and bytes.
- Content-blind relay/R2 scans for every browser-owned share flow.
