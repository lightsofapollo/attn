//! Canonical anchor index — the bridge between a snapshot's UTF-8 bytes and a
//! reviewer's possibly-edited local replica.
//!
//! Spec: `planning/collab/data-model.md` §Anchor Index +
//! `planning/collab/amendments.md` decision #16 (math + mermaid kinds).

#![allow(dead_code, unused_imports)]

pub mod index;
pub mod resolve;

pub use index::{AnchorIndexError, build_anchor_index};
pub use resolve::{PmStepJournal, ResolveError, resolve_anchor};
