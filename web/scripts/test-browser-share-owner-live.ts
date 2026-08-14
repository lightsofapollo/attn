#!/usr/bin/env -S npx tsx
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';

import {
  base64UrlEncode,
  base64UrlDecode,
  buildAdmissionHeaderV3,
  deriveReadKeysV3,
  deriveShareLinkKeys,
} from '../src/lib/review/browser-crypto';
import { createOwnedRoomV3, deleteOwnedRoomV3 } from '../src/lib/review/browser-owner-bootstrap';
import { mineBrowserPow, type BrowserPowInputs } from '../src/lib/review/browser-pow';
import {
  BrowserShareOwnerRelayClient,
  EMPTY_SHARE_MANIFEST_DIGEST,
  buildShareBundleMutations,
  digestShareSnapshotManifest,
  sealDurableShareSnapshot,
} from '../src/lib/review/browser-share-owner';
import { openShareCapabilityBundle } from '../src/lib/review/browser-share';
import {
  BrowserDurableSharePersistence,
  createProductionDurableShareSession,
  decryptDurableShareSnapshot,
} from '../src/lib/review/browser-share-production';
import type { BrowserShareSessionState } from '../src/lib/review/browser-share-session';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const port = 8792;
const relayUrl = `http://127.0.0.1:${port}`;
const relay = spawn(path.join(relayRoot, 'node_modules', '.bin', 'wrangler'), [
  'dev', '--env', 'staging', '--local', '--port', String(port),
  '--var', 'QUOTA_ALLOW_UNATTRIBUTED_CREATES:true',
  '--var', 'BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes',
], { cwd: relayRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let relayLog = '';
relay.stdout.on('data', chunk => { relayLog += String(chunk); });
relay.stderr.on('data', chunk => { relayLog += String(chunk); });

function inlineMintPow(input: Omit<BrowserPowInputs, 'expiresAt' | 'rand' | 'counterStart'>): Promise<string> {
  const rand = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return Promise.resolve(mineBrowserPow({ ...input, expiresAt: Date.now() + 60_000, rand }).token);
}
async function waitForRelay(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${relayUrl}/health`)).ok) return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('relay did not become healthy');
}
let failures = 0;
function check(value: unknown, label: string): void {
  if (value) console.log(`PASS ${label}`);
  else { failures += 1; console.error(`FAIL ${label}`); }
}

async function nativeReviewerJoins(input: {
  shareId: string;
  roomId: string;
  linkSecret: Uint8Array;
}): Promise<boolean> {
  const child = spawn('cargo', [
    'test', '--test', 'durable_share_native_e2e',
    'browser_owned_share_native_reviewer_real_stack',
    '--', '--ignored', '--exact', '--nocapture',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ATTN_RELAY_URL: relayUrl,
      ATTN_BROWSER_OWNER_SHARE_ID: input.shareId,
      ATTN_BROWSER_OWNER_ROOM_ID: input.roomId,
      ATTN_BROWSER_OWNER_LINK_SECRET: base64UrlEncode(input.linkSecret),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (status !== 0) console.error(output.split('\n').slice(-40).join('\n'));
  return status === 0;
}

try {
  await waitForRelay();
  const room = await createOwnedRoomV3({ relayUrl, mintPow: inlineMintPow });
  check(room.created, 'browser creates the ordinary v3 epoch room');
  const shareId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const shareSecret = crypto.getRandomValues(new Uint8Array(32));
  const client = new BrowserShareOwnerRelayClient({
    relayUrl, shareId, identity: room.identity, mintPow: inlineMintPow,
  });
  const context = (revision: number, manifestDigest: string) => ({
    shareId, shareSecret, epoch: 0, revision, manifestDigest, roomId: room.roomId,
    ownerSigningKey: base64UrlEncode(room.identity.signingPublic),
    readCapabilityKey: room.keys.readKeys.readCapabilityKey,
    writeAdmissionKey: room.keys.writeAdmissionKey,
    commentGrantSignature: room.commentGrantSignature,
    suggestGrantSignature: room.suggestGrantSignature,
  });
  const dark = await client.upsert({
    v: 3, ownerSigningKey: base64UrlEncode(room.identity.signingPublic),
    bundles: buildShareBundleMutations(context(0, EMPTY_SHARE_MANIFEST_DIGEST)),
    epoch: 0, revision: 0, currentRoomId: null, snapshots: [], placeholders: [],
    deviceId: room.identity.deviceId,
  });
  check(dark.currentRoomId === undefined, 'ShareDO stays dark before retained upload');

  const fileId = base64UrlEncode(new Uint8Array(16).fill(21));
  const snapshotId = base64UrlEncode(new Uint8Array(16).fill(23));
  const sealed = await sealDurableShareSnapshot({
    shareId, epoch: 0, fileId, snapshotId, docType: 'markdown', content: '# Live browser owner\n',
    snapshotKey: room.keys.readKeys.snapshotKey,
  });
  const stagedSnapshot = await client.uploadSnapshot(fileId, snapshotId, sealed);
  sealed.fill(0);
  const staged = await client.fetchWithViewCapability(shareSecret);
  check(staged.revision === 0 && staged.snapshots.length === 0, 'relay keeps staged ciphertext private until the atomic publish');
  const finalRevision = staged.revision + 1;
  const manifestDigest = digestShareSnapshotManifest([stagedSnapshot]);
  const active = await client.upsert({
    v: 3, ownerSigningKey: staged.ownerSigningKey,
    bundles: buildShareBundleMutations(context(finalRevision, manifestDigest)),
    epoch: 0, revision: finalRevision, currentRoomId: room.roomId,
    snapshots: [stagedSnapshot], placeholders: staged.placeholders,
    deviceId: room.identity.deviceId,
  });
  check(active.currentRoomId === room.roomId, 'final pointer flip activates stable share');

  const viewKeys = deriveShareLinkKeys(shareSecret, 'view');
  const sharePath = `/v3/shares/${shareId}`;
  const recordResponse = await fetch(`${relayUrl}${sharePath}`, { headers: {
    'Attn-Share-Bundle': viewKeys.bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(viewKeys.readAdmissionKey, 'read', 'GET', sharePath, new Uint8Array(0)),
  } });
  const publicRecord = await recordResponse.json() as { bundle: { sealedBundle: string } };
  const bundle = openShareCapabilityBundle(viewKeys.bundleKey, viewKeys.bundleId, {
    shareId, epoch: 0, revision: finalRevision, manifestDigest: active.manifestDigest, tier: 'view',
  }, publicRecord.bundle.sealedBundle);
  const snapshotPath = `${sharePath}/snapshots/${fileId}`;
  const snapshotResponse = await fetch(`${relayUrl}${snapshotPath}`, { headers: {
    'Attn-Share-Bundle': viewKeys.bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(viewKeys.readAdmissionKey, 'read', 'GET', snapshotPath, new Uint8Array(0)),
  } });
  const downloaded = new Uint8Array(await snapshotResponse.arrayBuffer());
  const bundleReadCapability = base64UrlDecode(bundle.readCapabilityKey);
  const opened = await decryptDurableShareSnapshot(shareId, 0, {
    v: 3, shareId, bundleId: bundle.bundleId, epoch: 0, revision: finalRevision,
    manifestDigest: active.manifestDigest, roomId: room.roomId, tier: 'view',
    roomCapability: { ownerSigningKey: bundle.ownerSigningKey,
      // The durable bundle is rooted in the share's read capability, not the
      // ordinary room's read capability. Derive the matching v3 keys exactly
      // as the production resolver does.
      readCapabilityKey: new Uint8Array(bundleReadCapability),
      roomKeys: deriveReadKeysV3(bundleReadCapability) },
  }, fileId, snapshotId, downloaded);
  bundleReadCapability.fill(0);
  check(opened.content === '# Live browser owner\n', 'view bearer resolves and decrypts browser-owned snapshot');

  const emptyCommentMailbox = await client.fetchMailbox(shareSecret, 'comment', 0);
  check(emptyCommentMailbox.items.length === 0 && emptyCommentMailbox.nextAfter === 0,
    'browser owner authenticates the isolated comment mailbox query');
  await client.ackMailbox(0);
  check(true, 'browser owner signs the mailbox ACK query');

  const commentKeys = deriveShareLinkKeys(shareSecret, 'comment');
  try {
    let browserReviewerState: BrowserShareSessionState | null = null;
    const persistence = await BrowserDurableSharePersistence.open(new IDBFactory());
    const browserReviewer = await createProductionDurableShareSession({
      relayUrl,
      invite: { shareId, linkSecret: new Uint8Array(commentKeys.linkSecret) },
      tier: 'comment',
      persistence,
      disableWebRtc: true,
      liveStore: {
        currentRoomId: null,
        applyEvent: () => undefined,
        applySnapshot: () => undefined,
        setCurrentFile: () => undefined,
        setCurrentSnapshot: () => undefined,
      },
      registrationMintPow: input => inlineMintPow(input),
      outboxMintPow: input => inlineMintPow(input),
      mailboxMintPow: input => inlineMintPow({
        roomId: input.shareId,
        deviceId: input.deviceId,
        method: 'POST',
        path: input.path,
        difficulty: 12,
      }),
      onState: state => { browserReviewerState = state; },
    });
    await browserReviewer.start();
    const browserDeadline = Date.now() + 20_000;
    while (Date.now() < browserDeadline
      && (browserReviewerState?.status !== 'ready' || !browserReviewerState.ownerOnline)) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const browserJoined = browserReviewerState?.status === 'ready' && browserReviewerState.ownerOnline;
    check(browserJoined, 'production browser reviewer resolves and joins the browser-owned room live');
    if (!browserJoined) console.error('browser reviewer state:', browserReviewerState);
    browserReviewer.close();

    check(await nativeReviewerJoins({
      shareId,
      roomId: room.roomId,
      linkSecret: commentKeys.linkSecret,
    }), 'native reviewer resolves the browser stable bearer and joins its v3 room');
  } finally {
    commentKeys.linkSecret.fill(0);
    commentKeys.bundleKey.fill(0);
    commentKeys.readAdmissionKey.fill(0);
    commentKeys.writeAdmissionKey?.fill(0);
  }

  check(!relayLog.includes('# Live browser owner') && !relayLog.includes(base64UrlEncode(shareSecret)),
    'relay logs contain neither plaintext snapshot nor stable owner secret');

  await client.revoke();
  check((await fetch(`${relayUrl}${sharePath}`, { headers: {
    'Attn-Share-Bundle': viewKeys.bundleId,
    'Attn-Admission': buildAdmissionHeaderV3(viewKeys.readAdmissionKey, 'read', 'GET', sharePath, new Uint8Array(0)),
  } })).status === 404, 'owner-signed ShareDO revoke kills stable bearer');
  check(await deleteOwnedRoomV3({ relayUrl, roomId: room.roomId, identity: room.identity,
    writeAdmissionKey: room.keys.writeAdmissionKey, mintPow: inlineMintPow }), 'epoch room teardown accepted');
} catch (error) {
  failures += 1;
  console.error('FAIL live browser share owner:', error);
  console.error(relayLog.split('\n').slice(-30).join('\n'));
} finally {
  relay.kill('SIGTERM');
}

console.log(failures === 0 ? 'browser-share-owner-live: all green' : `browser-share-owner-live: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
