//! Persistent local room store under the attn runtime directory
//! (`runtime_dir()/reviews/`). Owns on-disk layout for rooms, snapshots,
//! events, outbox, and sync cursors.
//!
//! Spec: `planning/collab/data-model.md` §Local Replicas and §Rust
//! Architecture Changes §Local Review Store. Implementation lands in issue
//! attn-nnj.2.3.

#![allow(dead_code)]
