//! Multi-peer review-event convergence test (attn-sls / epic attn-k3v).
//!
//! Reproduces the asymmetric sync bug the user reports: in a 3-peer room
//! (owner + reviewerB + reviewerC), a comment authored by reviewerB must
//! converge to **both** the owner **and** reviewerC. The lived symptom is
//! "changes on one side that don't appear on the other".
//!
//! ## Why this needs no UDP/WebRTC
//!
//! Review events (comments/suggestions) are *relay-mediated*, end to end:
//!
//! ```text
//!   submit(CreateComment) -> Bootstrapper::send_event_sync -> durable outbox
//!     -> OutboxProcessor POST /v2/rooms/:id/envelopes (HTTP)
//!     -> relay broadcastFreshEnvelopes -> every *subscribed* WS socket
//!     -> InboundPipeline (decrypt+verify) -> events.jsonl -> ReviewUpdate::EventImported
//! ```
//!
//! They never touch the WebRTC DataChannel mesh (that path is `send_collab`,
//! used only for live co-typing/cursors). So a faithful convergence test only
//! needs the **real Miniflare relay** — booted via `WranglerHandle`, gated the
//! same way as `tests/relay_conformance.rs` (`ATTN_SKIP_CONFORMANCE` /
//! wrangler availability). This makes it far more CI-robust than the
//! UDP-flaky `webrtc_e2e` suite.
//!
//! ## What each outcome tells us
//!
//! - **owner sees it, reviewerC does NOT** → the bug is reproduced at the
//!   relay-mediated layer (a peer isn't receiving the relay broadcast).
//! - **all three converge** → the relay-mediated path is sound on localhost,
//!   and the reported drop is specific to the WebRTC/live path or to a real
//!   network topology — motivating the `webrtc_e2e` 3-peer extension and the
//!   Docker topology matrix (attn-8zd / attn-orf).
//!
//! Run locally:
//! ```bash
//! cargo test --test review_sync_convergence -- --nocapture
//! ATTN_SKIP_CONFORMANCE=1 cargo test --test review_sync_convergence   # skip
//! ```

#![allow(clippy::needless_return)]

#[path = "relay_helpers/mod.rs"]
mod relay_helpers;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::sync::RwLock;

use attn::review::manager::{ReviewCommand, ReviewManager, ReviewUpdate, UpdateSink};
use attn::review::model::{
    Anchor, PositionAnchor, ReviewEventBody, SuggestionDraft, SuggestionOperation,
};
use attn::review::store::ReviewStore;
use attn::review::working_copy::WorkingCopyService;

use relay_helpers::{WranglerHandle, is_wrangler_available, skip_requested};

/// One participant: a manager bootstrapped against the relay, plus a buffer
/// that captures every `ReviewUpdate` the manager emits (the same sink the
/// daemon wires into the tao event loop).
struct Peer {
    name: &'static str,
    mgr: ReviewManager,
    updates: Arc<StdMutex<Vec<ReviewUpdate>>>,
    store: Arc<ReviewStore>,
    // Held for lifetime — dropping these wipes the store/identity on disk.
    _store_tmp: TempDir,
    _id_tmp: TempDir,
}

impl Peer {
    /// Build a peer with its own isolated store + identity, bootstrapped
    /// against `relay_url`. Mirrors `make_bootstrapped_manager` in
    /// `src/review/manager.rs` tests, but uses the *public* `with_bootstrap`
    /// (reachable from an integration test) and points at a real relay.
    fn build(name: &'static str, relay_url: &str) -> Self {
        let store_tmp = TempDir::new().expect("store tempdir");
        let id_tmp = TempDir::new().expect("id tempdir");
        let store =
            Arc::new(ReviewStore::open_at(store_tmp.path().join("reviews")).expect("open store"));
        let working_copy = Arc::new(WorkingCopyService::new());

        let updates: Arc<StdMutex<Vec<ReviewUpdate>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink_updates = Arc::clone(&updates);
        let sink: UpdateSink = Arc::new(move |update| {
            sink_updates.lock().expect("sink mutex").push(update);
        });

        let cache = Arc::new(RwLock::new(HashMap::new()));
        let mgr = ReviewManager::new(Arc::clone(&store), working_copy, sink)
            .with_bootstrap(
                relay_url.to_string(),
                Some(id_tmp.path().to_path_buf()),
                cache,
            )
            .expect("attach bootstrap");

        Peer {
            name,
            mgr,
            updates,
            store,
            _store_tmp: store_tmp,
            _id_tmp: id_tmp,
        }
    }

    /// Snapshot the captured updates (clone out so we don't hold the lock).
    fn snapshot(&self) -> Vec<ReviewUpdate> {
        self.updates.lock().expect("updates mutex").clone()
    }

    /// True once this peer has imported a `CommentCreated` whose body matches
    /// `marker`. Works for both the author (local echo) and remote importers,
    /// because `EventImported` fires on both paths.
    fn saw_comment(&self, marker: &str) -> bool {
        self.snapshot().iter().any(|u| match u {
            ReviewUpdate::EventImported { event, .. } => {
                matches!(&event.body, ReviewEventBody::CommentCreated { body, .. } if body == marker)
            }
            _ => false,
        })
    }

    /// First `ShareReady` invite URL this peer emitted, if any.
    fn invite_url(&self) -> Option<String> {
        self.snapshot().into_iter().find_map(|u| match u {
            ReviewUpdate::ShareReady { invite_url, .. } => Some(invite_url),
            _ => None,
        })
    }

    fn tier_invite(&self, tier: &str) -> Option<String> {
        self.snapshot().into_iter().find_map(|update| match update {
            ReviewUpdate::ShareReady {
                invite_url,
                view_invite_url,
                suggest_invite_url,
                ..
            } => match tier {
                "view" => Some(view_invite_url),
                "comment" => Some(invite_url),
                "suggest" => Some(suggest_invite_url),
                _ => None,
            },
            _ => None,
        })
    }

    fn saw_suggestion(&self, replacement: &str) -> bool {
        self.snapshot().iter().any(|update| match update {
            ReviewUpdate::EventImported { event, .. } => matches!(
                &event.body,
                ReviewEventBody::SuggestionCreated {
                    operation: SuggestionOperation::Replace { replacement: value, .. },
                    ..
                } if value == replacement
            ),
            _ => false,
        })
    }

    fn saw_grant_forbidden(&self) -> bool {
        self.snapshot().iter().any(|update| {
            matches!(update, ReviewUpdate::Error { code, .. } if code == "ATTN_GRANT_FORBIDDEN")
        })
    }

    /// First `ShareReady` / room-bearing room id this peer learned, if any.
    fn room_id(&self) -> Option<attn::review::ids::RoomId> {
        self.snapshot().into_iter().find_map(|u| match u {
            ReviewUpdate::ShareReady { room_id, .. } => Some(room_id),
            ReviewUpdate::RoomStatusChanged { room_id, .. } => Some(room_id),
            ReviewUpdate::EventImported { room_id, .. } => Some(room_id),
            _ => None,
        })
    }
}

/// Poll `cond` until it returns true or `timeout` elapses. Never sleeps blind —
/// re-checks every 200ms. Returns whether the condition was met.
fn poll_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    cond()
}

/// A placeholder anchor — `CreateComment` just packages it into the event;
/// the relay/inbound path doesn't resolve it against a document, so fixed IDs
/// are fine for a convergence assertion. Shape mirrors `tests/webrtc_e2e.rs`.
fn placeholder_anchor() -> Anchor {
    fn id<T: for<'de> serde::Deserialize<'de>>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .expect("typed id deserializes")
    }
    Anchor {
        v: 2,
        file_id: id("f-file-01"),
        snapshot_id: id("eQ7pDCC-mekpz-we7gDYag"),
        base_hash: id("fB6AfMm0EkvWvuNrQNlXoK1cxgj8AjmFiOVq8P1Td3Y"),
        position: PositionAnchor {
            byte_range: [0, 9],
            line_range: [1, 1],
            pm_range: None,
        },
        quote: None,
        block: None,
        context: None,
        structure: None,
        html: None,
    }
}

fn temp_markdown() -> (TempDir, std::path::PathBuf) {
    let dir = TempDir::new().expect("markdown tempdir");
    let path = dir.path().join("shared-doc.md");
    std::fs::write(&path, "# Shared\n\nseed line\n").expect("write fixture");
    (dir, path)
}

/// Drive the 3-peer convergence scenario in `mode` and return
/// `(owner_saw, reviewerC_saw)` for reviewerB's comment.
fn run_scenario(relay_url: &str, mode: &str) -> (bool, bool) {
    let owner = Peer::build("owner", relay_url);
    let rvb = Peer::build("reviewerB", relay_url);
    let rvc = Peer::build("reviewerC", relay_url);

    // 1. Owner shares — `submit` blocks through the bootstrap, so ShareReady is
    //    already buffered when it returns.
    let (_doc, path) = temp_markdown();
    owner.mgr.submit(ReviewCommand::Share {
        path,
        selected_paths: Vec::new(),
        primary_path: None,
        mode: mode.to_string(),
        ttl: Some("24h".to_string()),
    });
    let invite = owner.invite_url().unwrap_or_else(|| {
        panic!(
            "owner must emit a ShareReady invite; updates={:#?}",
            owner.snapshot()
        )
    });
    let room_id = owner.room_id().expect("owner must know the room id");
    eprintln!(
        "[{mode}] owner shared room={} invite={}",
        room_id.as_str(),
        &invite[..invite.len().min(40)]
    );

    // 2. Both reviewers join (blocking through bootstrap).
    rvb.mgr.submit(ReviewCommand::Join {
        invite: invite.clone(),
    });
    rvc.mgr.submit(ReviewCommand::Join {
        invite: invite.clone(),
    });

    // 3. Give the room runtimes a moment to open their inbound WS subscription.
    //    We don't assert a specific status string (it varies by mode); the
    //    convergence poll below is the real signal.
    poll_until(Duration::from_secs(5), || {
        rvb.room_id().is_some() && rvc.room_id().is_some()
    });

    // 4. ReviewerB authors a comment.
    let marker = "CONVERGE_MARKER_RVB_0001";
    rvb.mgr.submit(ReviewCommand::CreateComment {
        room_id: room_id.clone(),
        anchor: placeholder_anchor(),
        body: marker.to_string(),
        parent_thread_id: None,
    });
    assert!(
        rvb.saw_comment(marker),
        "[{mode}] author (reviewerB) must have its own comment locally"
    );

    // 5. Convergence: the comment must reach the owner AND reviewerC.
    let owner_saw = poll_until(Duration::from_secs(20), || owner.saw_comment(marker));
    let rvc_saw = poll_until(Duration::from_secs(20), || rvc.saw_comment(marker));

    eprintln!(
        "[{mode}] convergence: owner_saw={owner_saw} reviewerC_saw={rvc_saw} (peer {} authored)",
        rvb.name
    );

    // Stop the rooms so the relay child shutdown is clean.
    owner.mgr.submit(ReviewCommand::Stop { room_id: None });
    rvb.mgr.submit(ReviewCommand::Stop { room_id: None });
    rvc.mgr.submit(ReviewCommand::Stop { room_id: None });

    (owner_saw, rvc_saw)
}

/// Hybrid mode keeps the mailbox/relay always-on for every peer, so review
/// events SHOULD broadcast to all three over the relay with no WebRTC needed.
/// This is the core deterministic reproduction surface.
#[test]
fn three_peer_comment_converges_hybrid() {
    if skip_requested() || !is_wrangler_available() {
        eprintln!("(skip) review_sync_convergence: ATTN_SKIP_CONFORMANCE set or wrangler missing");
        return;
    }

    // Small runtime only to boot the relay + health-wait. Each manager builds
    // its own multi-thread runtime internally via `with_bootstrap`.
    let boot_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("boot runtime");
    let relay = match boot_rt.block_on(WranglerHandle::start()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("(skip) could not start Miniflare relay: {e}");
            return;
        }
    };

    let (owner_saw, rvc_saw) = run_scenario(&relay.base_url, "hybrid");

    assert!(
        owner_saw,
        "owner must receive reviewerB's comment (basic relay delivery)"
    );
    assert!(
        rvc_saw,
        "reviewerC must receive reviewerB's comment — if this fails, the \
         asymmetric review-event drop is reproduced at the relay-mediated layer"
    );
}

/// LIVE mode is the default share mode (`cli_review.rs` `--mode` default and
/// the ShareDialog default). The selector sets `mailbox: None` ("mailbox is
/// unused") in Live mode. THE decisive experiment: does a Live room still open
/// the inbound WS event subscription, or does it lean on WebRTC for events?
/// If review events don't converge here, the reported asymmetric drop is a
/// Live-mode subscription gap — review events ride the relay, but Live mode
/// doesn't keep the relay subscription that delivers them.
#[test]
fn three_peer_comment_converges_live() {
    if skip_requested() || !is_wrangler_available() {
        eprintln!("(skip) review_sync_convergence: ATTN_SKIP_CONFORMANCE set or wrangler missing");
        return;
    }

    let boot_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("boot runtime");
    let relay = match boot_rt.block_on(WranglerHandle::start()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("(skip) could not start Miniflare relay: {e}");
            return;
        }
    };

    let (owner_saw, rvc_saw) = run_scenario(&relay.base_url, "live");

    eprintln!("[live] RESULT owner_saw={owner_saw} reviewerC_saw={rvc_saw}");
    assert!(
        owner_saw,
        "owner must receive reviewerB's comment (live mode)"
    );
    assert!(
        rvc_saw,
        "reviewerC must receive reviewerB's comment — Live mode is the DEFAULT; \
         a failure here reproduces the asymmetric review-event drop"
    );
}

/// Async mode: mailbox-only, no WebRTC arm at all. The strictest relay-only
/// fan-out check. If hybrid passes but async fails (or vice versa), the
/// divergence localizes the bug to a mode-specific subscription gap.
#[test]
fn three_peer_comment_converges_async() {
    if skip_requested() || !is_wrangler_available() {
        eprintln!("(skip) review_sync_convergence: ATTN_SKIP_CONFORMANCE set or wrangler missing");
        return;
    }

    let boot_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("boot runtime");
    let relay = match boot_rt.block_on(WranglerHandle::start()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("(skip) could not start Miniflare relay: {e}");
            return;
        }
    };

    let (owner_saw, rvc_saw) = run_scenario(&relay.base_url, "async");

    assert!(owner_saw, "owner must receive reviewerB's comment (async)");
    assert!(
        rvc_saw,
        "reviewerC must receive reviewerB's comment (async, relay-only fan-out)"
    );
}

/// Real local relay tier matrix. Native view-only joins intentionally stop
/// with the product's browser-required diagnostic; comment and suggest tiers
/// then exercise authoring and owner apply through Miniflare.
#[test]
fn v3_tiers_enforce_comment_and_suggestion_end_to_end() {
    if skip_requested() || !is_wrangler_available() {
        eprintln!("(skip) v3 tier convergence: wrangler unavailable or skip requested");
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("relay runtime");
    let relay = match runtime.block_on(WranglerHandle::start()) {
        Ok(relay) => relay,
        Err(error) => {
            eprintln!("(skip) could not start Miniflare relay: {error}");
            return;
        }
    };

    let owner = Peer::build("owner", &relay.base_url);
    let commenter = Peer::build("commenter", &relay.base_url);
    let suggester = Peer::build("suggester", &relay.base_url);
    let viewer = Peer::build("viewer", &relay.base_url);
    let (_doc, path) = temp_markdown();
    owner.mgr.submit(ReviewCommand::Share {
        path: path.clone(),
        selected_paths: Vec::new(),
        primary_path: None,
        mode: "async".into(),
        ttl: Some("24h".into()),
    });
    let room_id = owner.room_id().expect("shared room");

    viewer.mgr.submit(ReviewCommand::Join {
        invite: owner.tier_invite("view").expect("view invite"),
    });
    assert!(viewer.snapshot().iter().any(|update| matches!(
        update,
        ReviewUpdate::Error { message, .. } if message.contains("open this invite in the browser")
    )));

    let comment_invite = owner.tier_invite("comment").expect("comment invite");
    commenter.mgr.submit(ReviewCommand::Join {
        invite: comment_invite.clone(),
    });
    let marker = "TIER_COMMENT_ROUNDTRIP";
    commenter.mgr.submit(ReviewCommand::CreateComment {
        room_id: room_id.clone(),
        anchor: placeholder_anchor(),
        body: marker.into(),
        parent_thread_id: None,
    });
    assert!(poll_until(Duration::from_secs(20), || owner.saw_comment(marker)));
    commenter.mgr.submit(ReviewCommand::CreateSuggestion {
        room_id: room_id.clone(),
        draft: SuggestionDraft {
            anchor: placeholder_anchor(),
            operation: SuggestionOperation::Replace {
                expected_text: "seed line".into(),
                replacement: "forbidden".into(),
            },
            note: None,
        },
    });
    assert!(commenter.saw_grant_forbidden());
    assert!(!owner.saw_suggestion("forbidden"));

    // Bypass the manager authoring guard and enqueue a correctly signed,
    // correctly encrypted SuggestionCreated from the comment-granted device.
    // A following valid comment is our deterministic barrier: once the owner
    // imports it, the hostile envelope was delivered earlier and rejected by
    // the inbound grant vocabulary check rather than merely delayed.
    let attn::review::bootstrap::ParsedInviteAny::V3(comment_capability) =
        attn::review::bootstrap::parse_invite_any(&comment_invite).expect("parse comment invite")
    else {
        panic!("comment invite must be v3")
    };
    let read_keys = attn::review::crypto::kdf::derive_read_keys_v3(
        &comment_capability.fragment.read_capability_key,
    );
    let identity = attn::review::bootstrap::load_identity_from(commenter._id_tmp.path())
        .expect("load hostile identity")
        .expect("hostile identity exists");
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let hostile =
        attn::review::envelope::assemble_event_envelope(attn::review::envelope::AssembleInput {
            event_key: *read_keys.event_key.as_bytes(),
            signing_key: identity.signing_key().expect("signing key"),
            room_id: room_id.clone(),
            author_id: identity.typed_participant_id(),
            device_id: identity.typed_device_id(),
            created_at_ms: now_ms,
            expires_at_ms: now_ms + 60_000,
            parent_event_ids: vec![],
            snapshot_id: None,
            body: ReviewEventBody::SuggestionCreated {
                suggestion_id: "hostile-comment-tier-suggestion".into(),
                anchor: placeholder_anchor(),
                operation: SuggestionOperation::Replace {
                    expected_text: "seed line".into(),
                    replacement: "hostile-wire".into(),
                },
                note: None,
            },
            kind: attn::review::model::EnvelopeKind::Event,
            client_nonce: None,
        })
        .expect("assemble hostile signed envelope");
    commenter
        .store
        .append_outbox(&room_id, &hostile)
        .expect("enqueue hostile envelope");
    let barrier = "POST_HOSTILE_VALID_COMMENT";
    commenter.mgr.submit(ReviewCommand::CreateComment {
        room_id: room_id.clone(),
        anchor: placeholder_anchor(),
        body: barrier.into(),
        parent_thread_id: None,
    });
    assert!(poll_until(Duration::from_secs(20), || owner.saw_comment(barrier)));
    assert!(!owner.saw_suggestion("hostile-wire"));

    suggester.mgr.submit(ReviewCommand::Join {
        invite: owner.tier_invite("suggest").expect("suggest invite"),
    });
    let snapshot = owner
        .store
        .iter_snapshots(&room_id)
        .expect("snapshots")
        .into_iter()
        .next()
        .expect("initial snapshot")
        .expect("snapshot decodes");
    let anchor = Anchor {
        v: 2,
        file_id: snapshot.file_id,
        snapshot_id: snapshot.snapshot_id,
        base_hash: snapshot.base_hash,
        position: PositionAnchor {
            byte_range: [10, 19],
            line_range: [3, 3],
            pm_range: None,
        },
        quote: None,
        block: None,
        context: None,
        structure: None,
        html: None,
    };
    let replacement = "accepted line";
    suggester.mgr.submit(ReviewCommand::CreateSuggestion {
        room_id: room_id.clone(),
        draft: SuggestionDraft {
            anchor,
            operation: SuggestionOperation::Replace {
                expected_text: "seed line".into(),
                replacement: replacement.into(),
            },
            note: Some("tier e2e".into()),
        },
    });
    assert!(poll_until(Duration::from_secs(20), || owner
        .saw_suggestion(replacement)));
    let suggestion_id = owner
        .store
        .iter_events(&room_id)
        .expect("events")
        .filter_map(Result::ok)
        .find_map(|event| match event.body {
            ReviewEventBody::SuggestionCreated {
                suggestion_id,
                operation:
                    SuggestionOperation::Replace {
                        ref replacement, ..
                    },
                ..
            } if replacement == "accepted line" => {
                serde_json::from_value(serde_json::Value::String(suggestion_id)).ok()
            }
            _ => None,
        })
        .expect("suggestion id");
    owner.mgr.submit(ReviewCommand::AcceptSuggestion {
        room_id: room_id.clone(),
        suggestion_id,
    });
    assert!(poll_until(Duration::from_secs(10), || {
        std::fs::read_to_string(&path).is_ok_and(|content| content.contains(replacement))
    }));

    for peer in [&owner, &commenter, &suggester] {
        peer.mgr.submit(ReviewCommand::Stop {
            room_id: Some(room_id.clone()),
        });
    }
}
