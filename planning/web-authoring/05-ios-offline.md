# iOS Safari and offline hardening

Depends on: Phase 00 and Phase 01

## Purpose

Make iOS Safari a release platform, not an assumed by-product of desktop WebKit
support. Preserve the reader/reviewer defined in `ios-ux.md` through offline,
capability-loss, address-bar, safe-area, and process-lifecycle states without
relying on background execution.

## Implementation steps

### Step 1 — Add installable app shell

Add manifest, icons, standalone display metadata, theme colors, and iOS-safe
navigation. Keep install optional; explain when Home Screen installation may
improve persistence without promising it.

### Step 2 — Add safe service-worker caching

Cache only immutable hashed app/font assets. Use network-first navigation with
last-known shell fallback, versioned activation, and an explicit update state.
Never cache user content, room APIs, invite/capability URLs, or error payloads.

### Step 3 — Implement capability-specific degraded modes

Exercise IndexedDB, CryptoKey cloning, OPFS, estimate, and persistence. Map
Private Browsing, Lockdown Mode, unavailable OPFS, and quota errors into the
typed storage modes and designed UI. Capability loss removes unsafe ownership
or edit actions while retaining the shared in-memory reader/reviewer whenever
WebCrypto and transport permit it.

### Step 4 — Harden lifecycle and memory behavior

Flush bounded local autosave on visibility/pagehide, resume from committed
revision after process kill, stop RTC cleanly, restart mailbox transport, and
avoid assuming service-worker background sync or closed-tab RTC.

### Step 5 — Establish real-device test protocol

Document supported current/previous iOS versions, iPhone/iPad device cases,
normal/private/Home Screen modes, keyboard/rotation/memory pressure, site-data
clear, and low-storage tests. Record release evidence in the Bead validation.

## Validation

- `npm --prefix web run check`
- Service worker tests prove forbidden routes/content are never cached.
- Playwright Chromium + WebKit offline launch, update, reload, and process-like
  termination tests.
- Real current iPhone and iPad Safari matrix is mandatory; Playwright WebKit is
  supplementary and cannot waive it.
- Kill Safari after typing, reopen, and verify the last committed revision.
- Private Browsing exit/reopen shows accurate data-loss behavior and preserves
  exported backup usability.
- Every capability mode matches the action matrix in `ios-ux.md`; view-only
  retains files, safe media, anchored review, export, and native handoff where
  their independent capabilities are available.
