//! Suggestion resolution and guarded write flow: takes an accepted
//! suggestion event, re-resolves anchors against the current working copy,
//! and applies the edit through `working_copy::WorkingCopyService`.
//!
//! Spec: `planning/collab/data-model.md` §Implementation Phases §Phase 5
//! (Owner Apply Flow). Implementation lands in Phase 5.

#![allow(dead_code)]
