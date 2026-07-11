//! Native half of the durable-share real-stack E2E. The shell/TS orchestrator
//! invokes this one ignored test in explicit phases while a real local relay
//! remains alive, so production owner state survives process restarts.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use attn::review::{
    bootstrap::{BootstrapConfig, Bootstrapper, load_or_create_identity_in},
    crypto::{
        kdf::{derive_room_key_tree_v3, derive_share_epoch_room_secret},
        pow::TokenPool,
    },
    model::ReviewEventBody,
    share_lifecycle::{DurableShareService, DurableShareStore, HttpShareRelayClient},
    store::ReviewStore,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::Signer as _;
use hmac::{Hmac, Mac as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessState {
    share_id: String,
    room_id: String,
    view_browser: String,
    comment_browser: String,
    suggest_browser: String,
    snapshot_content: String,
    #[serde(default)]
    imported_comment_bodies: Vec<String>,
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required for durable share E2E"))
}

fn paths() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let root = PathBuf::from(required("ATTN_SHARE_E2E_ROOT"));
    (
        root.join("shares"),
        root.join("reviews"),
        root.join("identity"),
        PathBuf::from(required("ATTN_SHARE_E2E_STATE")),
    )
}

fn service() -> (
    DurableShareService,
    Arc<DurableShareStore>,
    Arc<ReviewStore>,
) {
    let (share_path, review_path, identity_path, _) = paths();
    let relay_url = required("ATTN_RELAY_URL");
    let store = Arc::new(DurableShareStore::open_at(share_path).expect("open durable share store"));
    let review_store = Arc::new(ReviewStore::open_at(review_path).expect("open review store"));
    let identity = load_or_create_identity_in(&identity_path).expect("load owner identity");
    let relay = Arc::new(
        HttpShareRelayClient::new(relay_url.clone(), &identity).expect("owner relay client"),
    );
    let bootstrap = Arc::new(
        Bootstrapper::new(
            Arc::clone(&review_store),
            Arc::new(BootstrapConfig {
                relay_url,
                identity_dir: Some(identity_path),
            }),
        )
        .expect("owner bootstrapper"),
    );
    (
        DurableShareService::new(
            Arc::clone(&store),
            Arc::clone(&review_store),
            relay,
            bootstrap,
        ),
        store,
        review_store,
    )
}

fn read_state(path: &Path) -> HarnessState {
    serde_json::from_slice(&std::fs::read(path).expect("read harness state"))
        .expect("decode harness state")
}

fn write_state(path: &Path, state: &HarnessState) {
    std::fs::write(
        path,
        serde_json::to_vec_pretty(state).expect("encode harness state"),
    )
    .expect("write harness state");
}

fn canonical_request(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
    let mut value = Vec::new();
    value.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    value.push(b'\n');
    value.extend_from_slice(path.as_bytes());
    value.extend_from_slice(b"\n\n");
    value.extend_from_slice(&Sha256::digest(body));
    value
}

async fn destroy_actual_room(store: &DurableShareStore, state: &HarnessState) {
    let (_, _, identity_path, _) = paths();
    let record = store
        .load(&state.share_id)
        .expect("load owner share record");
    let root = record.share_secret.as_ref().expect("active share root");
    let epoch_secret = derive_share_epoch_room_secret(root.expose(), record.epoch);
    let tree = derive_room_key_tree_v3(epoch_secret.as_bytes());
    assert_eq!(
        record
            .current_room_id
            .as_ref()
            .expect("current room")
            .as_str(),
        state.room_id
    );
    let identity = load_or_create_identity_in(&identity_path).expect("owner identity");
    let seed: [u8; 32] = URL_SAFE_NO_PAD
        .decode(identity.signing_key.as_bytes())
        .expect("owner seed")
        .try_into()
        .expect("32-byte owner seed");
    let path = format!("/v3/rooms/{}", state.room_id);
    let canonical = canonical_request("DELETE", &path, &[]);
    let signature = ed25519_dalek::SigningKey::from_bytes(&seed).sign(&canonical);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(tree.write_admission_key.as_bytes()).expect("HMAC key");
    mac.update(&canonical);
    let admission = format!(
        "v3.write.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let pow = TokenPool::new(
        state.room_id.clone(),
        identity.device_id.clone(),
        12,
        300_000,
    )
    .take("DELETE", &path)
    .await
    .expect("room delete PoW");
    let response = reqwest::Client::new()
        .delete(format!(
            "{}{}",
            required("ATTN_RELAY_URL").trim_end_matches('/'),
            path
        ))
        .header("Attn-Device-Id", &identity.device_id)
        .header("Attn-Admission", admission)
        .header(
            "Attn-Owner-Signature",
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        )
        .header("Attn-PoW", pow)
        .send()
        .await
        .expect("DELETE actual RoomDO");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::NO_CONTENT,
        "room delete failed: {}",
        response.text().await.unwrap_or_default()
    );
}

#[tokio::test]
#[ignore = "orchestrated by scripts/test-share-e2e.sh against a live local relay"]
async fn durable_share_native_real_stack_phase() {
    let phase = required("ATTN_SHARE_E2E_PHASE");
    let (service, store, review_store) = service();
    let (_, _, _, state_path) = paths();
    match phase.as_str() {
        "create" => {
            let document = PathBuf::from(required("ATTN_SHARE_E2E_DOCUMENT"));
            let snapshot_content =
                std::fs::read_to_string(&document).expect("read shared document");
            let links = service
                .create(&document)
                .await
                .expect("production durable share create");
            write_state(
                &state_path,
                &HarnessState {
                    share_id: links.share_id.clone(),
                    room_id: links.room_id.as_str().to_owned(),
                    view_browser: links.view_browser.clone(),
                    comment_browser: links.comment_browser.clone(),
                    suggest_browser: links.suggest_browser.clone(),
                    snapshot_content,
                    imported_comment_bodies: Vec::new(),
                },
            );
        }
        "destroy_room" => {
            let state = read_state(&state_path);
            destroy_actual_room(&store, &state).await;
            // ShareDO and its retained snapshot must remain independently alive.
            assert!(store.load(&state.share_id).is_ok());
        }
        "restart" => {
            let mut state = read_state(&state_path);
            let links = service
                .renew(Some(&state.share_id))
                .await
                .expect("owner restart renew/drain");
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].share_id, state.share_id);
            assert_eq!(
                links[0].room_id.as_str(),
                state.room_id,
                "same epoch must recreate the same room"
            );
            let room_id = links[0].room_id.clone();
            state.imported_comment_bodies = review_store
                .iter_events(&room_id)
                .expect("owner events")
                .map(|event| event.expect("stored event"))
                .filter_map(|event| match event.body {
                    ReviewEventBody::CommentCreated { body, .. } => Some(body),
                    _ => None,
                })
                .collect();
            assert!(
                state
                    .imported_comment_bodies
                    .iter()
                    .any(|body| body == "offline across native restart"),
                "owner ReviewStore did not import the production browser comment"
            );
            write_state(&state_path, &state);
        }
        "revoke" => {
            let state = read_state(&state_path);
            service
                .revoke(&state.share_id)
                .await
                .expect("production durable share revoke");
        }
        other => panic!("unknown ATTN_SHARE_E2E_PHASE {other}"),
    }
}
