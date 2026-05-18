//! Serde types for rooms, participants, snapshots, events, envelopes, and
//! sync cursors that make up the review domain wire/storage format.
//!
//! Spec: `planning/collab/data-model.md` §Terms, §Snapshot Graph,
//! §Review Events, §Encrypted Envelopes, §Sync Cursors And ACKs.
//! Concrete types land in issue attn-nnj.2.2.

#![allow(dead_code)]
