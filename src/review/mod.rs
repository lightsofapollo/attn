//! Review collaboration domain — owns durable collaboration state and
//! working-copy mutation for the attn daemon.
//!
//! Spec: `planning/collab/data-model.md` §Rust Architecture Changes
//! §New Rust Modules. Submodules are scaffolded as stubs and will be filled
//! in by follow-up issues under epic attn-nnj.2.

#![allow(dead_code)]

pub mod agent;
pub mod agent_identity;
pub mod anchors;
pub mod apply;
pub mod bootstrap;
pub mod crypto;
pub mod diff_suggestions;
pub mod envelope;
pub mod ids;
pub mod ipc;
pub mod manager;
pub mod model;
pub mod store;
pub mod transport;
pub mod watcher_state;
pub mod working_copy;
