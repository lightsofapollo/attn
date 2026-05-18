//! Typed frontend-facing review IPC commands and events. Additive variants
//! on top of the existing `IpcMessage` / `SocketMessage` enums.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §Webview IPC Changes / §Daemon Socket Commands. Concrete variants land
//! in issue attn-nnj.2.9.

#![allow(dead_code)]
