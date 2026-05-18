//! Transport abstraction: mailbox / WebSocket / WebRTC client trait plus
//! concrete implementations used by `ReviewManager` to ship envelopes.
//!
//! Spec: `planning/collab/data-model.md` §Transport Model and
//! `planning/collab/relay-spec.md`. Implementations land in Phase 3b
//! (Cloudflare relay/mailbox) and Phase 4 (WebRTC).

#![allow(dead_code)]
