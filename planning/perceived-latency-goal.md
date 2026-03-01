# Perceived Latency Goal (<100ms Interactions)

## Objective
Every user action should receive visible UI feedback in under 100ms (perceived), while expensive filesystem and tree work streams in asynchronously.

## User-Visible SLOs
- P50 input acknowledgement: <30ms
- P95 input acknowledgement: <100ms
- P95 project switch shell (header + picker + placeholder tree): <100ms
- P95 first usable tree rows (cold): <250ms
- P95 first usable tree rows (warm): <100ms

## Architecture Direction
1. Event loop remains non-blocking (no full tree scans inline).
2. Project switch is two-phase:
   - Immediate: shallow/root snapshot + active file metadata.
   - Deferred: background full tree hydration.
3. Watcher updates are coalesced and filtered, with background tree refresh.
4. UI applies incremental updates and avoids full recomputation during bursts.

## Current Implementation Milestones
- [x] Fast switch payload with shallow root snapshot.
- [x] Background full-tree hydration after switch/startup.
- [x] Watcher-triggered tree refresh moved off event loop.
- [x] Watcher ignores noisy build/dependency/hidden paths.
- [x] Protocol-level tree deltas (`treeOps` + `treePatch`) replace full-tree updates for common churn paths.
- [x] Expand-driven lazy subtree loading.
- [ ] Virtualized tree rendering and incremental search index.

## Notes
Absolute <100ms completion for all filesystem operations is unrealistic on very large/cold/network filesystems. The product goal is <100ms perceived responsiveness with progressive hydration.
