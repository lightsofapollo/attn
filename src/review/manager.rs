//! In-memory `ReviewManager` runtime: event import/export, status updates,
//! outbox processing, and lifecycle for active rooms. Driven from the tao
//! event loop via `UserEvent::Review`.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §Review Manager. Implementation lands in issue attn-nnj.2.8.

#![allow(dead_code)]
