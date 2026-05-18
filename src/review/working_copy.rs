//! Working-copy service: path binding, content hashing, snapshot creation,
//! safe writes, and local revision recording. Replaces direct `fs::write`
//! calls from IPC handlers.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §Working Copy Service / §File Watcher Integration. Implementation lands
//! in issues attn-nnj.2.4 – attn-nnj.2.6.

#![allow(dead_code)]
