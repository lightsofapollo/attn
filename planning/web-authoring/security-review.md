# Browser workspace security review

Status: reviewed on 2026-07-11. No open critical or high-severity findings were identified in the browser-owned sharing path. Production cutover and physical iOS validation remain separate human gates.

## Scope and trust boundaries

The review covers browser workspace storage, import, rendering, service-worker behavior, browser-owned relay rooms, stable share capabilities, encrypted snapshot publication, reviewer admission, offline mailbox draining, and native/browser interoperability.

Workspace content is plaintext inside the trusted browser runtime while it is open. At rest, workspace records and share-owner state are sealed with non-extractable browser keys; large payloads may live in OPFS under the same sealed-record model. This protects persisted data and supports cryptographic erasure, but it does not protect against a compromised same-origin runtime, malicious browser extension, compromised device, or an attacker controlling an unlocked session.

Relay and hosting operators can observe traffic metadata such as opaque identifiers, timing, size, and network addresses. They do not receive workspace plaintext or invite secrets: stable invite capability material remains in the URL fragment, and published snapshots, events, and mailbox items are encrypted and authenticated in the browser.

## Controls reviewed

- Hosted responses enforce a restrictive CSP, same-origin opener/resource policies, no-referrer, HSTS, MIME sniffing protection, frame denial, and a narrow permissions policy. HTML and service-worker entry points are non-cacheable; hashed static assets are immutable.
- The service worker caches only application shells and static assets. It excludes cross-origin requests, query-bearing requests, and user workspace content. Push payloads contain no document plaintext; notification details are decrypted locally.
- Markdown parsing disables embedded HTML. Hosted HTML previews run in an iframe without sandbox capabilities and with a no-referrer policy. Mermaid uses strict security mode, and KaTeX keeps its default untrusted-input behavior.
- Relay owner requests omit credentials, disable caching, and use authenticated canonical request material. Room ownership, reviewer grants, envelopes, acknowledgements, revocation, and teardown are signed and verified using the native protocol shapes.
- Reviewer mailbox items are validated before forwarding: cursor continuity, bundle identity, device registration, owner grant, permitted event type, AEAD authentication, derived IDs, and Ed25519 signatures are checked. The source item is acknowledged only after durable forwarding.
- ZIP imports normalize and validate paths before expansion and enforce archive-size, entry-count, per-entry, and total-expanded-size limits. Traversal and expansion-budget cases have regression tests.
- Local and session storage contain presentation preferences and transient UI state only. Workspace roots, stable owner secrets, and invite capability keys are not persisted there.
- Production dependency audit for the web and relay packages reported no vulnerabilities at high severity or above. The live relay harness also scans logs for workspace plaintext and stable owner secrets.

## Findings

### Fixed: unbounded ZIP expansion

Imported ZIP metadata previously had no explicit expansion budget. The importer now rejects archives over 64 MiB, more than 1,024 entries, individual expanded files over 64 MiB, or aggregate expanded content over 128 MiB. Paths are rejected before decompression when they are absolute, traverse upward, contain NUL bytes, or otherwise normalize outside the archive root.

### Accepted limitations

- Trusted Types are not enforced because support and compatibility across the target iOS/Safari matrix are incomplete. HTML-producing sinks are instead limited to audited renderers and sandboxed preview surfaces under CSP.
- A local notification may reveal the locally decrypted document name or activity count on the device lock screen according to the user's OS notification settings.
- Possession of a stable invite URL fragment grants the advertised reviewer capability until the owner revokes or tears down the share. This is intentional bearer-capability behavior and is surfaced as such in the Share UI.
- A Rust advisory scan could not be run because `cargo-audit` is not installed in the validation environment. Cargo compilation and the protocol/interoperability test suites remain required quality gates.

## Evidence

The feature validation record is in `validation-03.md`, and the native/browser coverage map is in `parity-matrix.md`. Automated evidence includes browser unit tests, hosted-route boundary tests, staging Playwright coverage, relay integration tests, Rust share-lifecycle tests, native-to-browser and browser-to-native live relay harnesses, folder sharing, WebRTC, revocation, teardown, and ciphertext/log leakage checks.

The remaining gates do not change this review result: physical iOS Safari verification requires real devices, and production routing requires explicit human approval.
