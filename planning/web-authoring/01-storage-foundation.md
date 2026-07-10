# Browser workspace storage v3

Depends on: none

## Purpose

Extend the proven room-oriented IndexedDB/OPFS implementation into a complete
browser-local workspace store. IndexedDB is the compatibility baseline; OPFS is
an optional encrypted large-body tier.

## Implementation steps

### Step 1 — Define schema v3 and migrations

Add workspace, workspace-key, typed entry (Markdown or asset), immutable
revision/body, share-capability, recovery, and garbage-collection stores to
`browser-storage.ts`. Specify keys,
indexes, versioned record validation, size caps, and v2→v3 migration fixtures.

### Step 2 — Implement local key and revision sealing

Create non-extractable workspace HKDF roots, domain-separated keys, sealed
small revision bodies, and wrapped invite capability records. Zero transient
key/plaintext buffers and bind routing metadata as AEAD AAD.

### Step 3 — Implement workspace/file transactions

Add atomic create/rename/delete/select/commit-head APIs for Markdown and assets,
immutable revision history, relative-path uniqueness, per-workspace monotonic
timestamps, optimistic conflict/fencing checks, and crash-safe error semantics.

### Step 4 — Add OPFS tier and IndexedDB fallback

Add opaque paths, temp-write/promote/GC protocol, read verification, and a
configurable size threshold for Markdown revisions and asset bodies. Every
operation must fall back to encrypted IndexedDB Blob/ArrayBuffer storage when
OPFS is absent or fails.

### Step 5 — Add capability and durability probes

Round-trip IndexedDB, non-extractable `CryptoKey`, and OPFS operations. Expose
typed `persistent | best_effort | volatile | unsupported` state plus quota
estimate and precise failure causes. Do not user-agent sniff.

### Step 6 — Add cross-tab writer lease

Use IndexedDB transactions and fencing tokens for single-writer ownership,
heartbeat/takeover, and read-only secondary tabs. BroadcastChannel may notify
tabs but cannot decide correctness.

## Validation

- `npm --prefix web run check`
- `node --import tsx web/src/lib/review/browser-storage.test.ts`
- Migration corpus for empty, v1, v2, interrupted claim, and corrupt v3 data.
- Property tests for atomic head advancement, conflicting leases, idempotent
  commits, and crypto-erasure.
- Fault injection for `QuotaExceededError`, transaction abort, OPFS write/close
  failure, missing OPFS, and orphan cleanup.
- Real Chromium and WebKit Playwright persistence/reload tests.
- Manual current iOS Safari: normal tab, Private Browsing, Home Screen app,
  denied/best-effort persistence, storage clear, and low-storage simulation.
