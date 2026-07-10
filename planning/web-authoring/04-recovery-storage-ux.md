# Recovery and storage UX

Depends on: Phase 01 and Phase 02

## Purpose

Make the accountless durability contract understandable and recoverable. Users
must know what is local, what is shared as ciphertext, and what cannot be
recovered if browser storage is cleared.

## Implementation steps

### Step 1 — Implement storage status and pressure UI

Show persistence state, accessible usage/quota, last successful backup, OPFS
fallback state, and per-workspace size. Handle unknown estimates without fake
precision.

### Step 2 — Add Markdown backup/export

Export one file, workspace zip, or all workspaces through browser downloads and
iOS Files share sheet. Workspace exports contain normal Markdown, original
asset bytes/paths, and a small non-secret manifest; never require attn to
recover the content.

### Step 3 — Add import and conflict handling

Import Markdown/assets/zip backups with validation, path and media normalization, duplicate
workspace choices, and atomic commit. Imported content creates a new local
workspace and never silently reconnects an old room.

### Step 4 — Add first-share durability gate

Request persistent storage from a user gesture, offer backup, explain
best-effort/volatile risk, and require explicit acknowledgement before sharing
from non-persistent storage.

### Step 5 — Add crypto-erasure and room cleanup controls

Support delete workspace, forget room, stop sharing, and clear all local attn
data as separate operations with accurate consequences. Delete local keys first
for crypto-erasure, then clean IndexedDB/OPFS records.

## Validation

- Unit tests for status mapping, size formatting, manifests, import validation,
  path traversal, duplicate naming, and destructive confirmations.
- Playwright export/import round trip produces byte-identical Markdown and assets
  with identical normalized relative paths.
- Persistence denied/unknown, quota pressure, missing OPFS, and cleared-site
  recovery copy are screenshot-tested.
- iOS Safari Files export/import and Home Screen persistence manual matrix.
- Security review confirms no secret in filenames, manifests, downloads,
  analytics, URL query, service-worker cache, or error telemetry.
