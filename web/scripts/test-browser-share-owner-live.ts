#!/usr/bin/env -S npx tsx
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  base64UrlEncode,
  buildAdmissionHeaderV3,
  deriveShareLinkKeys,
} from '../src/lib/review/browser-crypto';
import { createOwnedRoomV3, deleteOwnedRoomV3 } from '../src/lib/review/browser-owner-bootstrap';
import { mineBrowserPow } from '../src/lib/review/browser-pow';
import {
  BrowserShareOwnerRelayClient,
  EMPTY_SHARE_MANIFEST_DIGEST,
  buildShareBundleMutations,
  sealDurableShareSnapshot,
} from '../src/lib/review/browser-share-owner';
import { openShareCapabilityBundle } from '../src/lib/review/browser-share';
import { decryptDurableShareSnapshot } from '../src/lib/review/browser-share-production';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function inlineMintPow(input: Parameters<typeof mineBrowserPow>[0]): Promise<string> {
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
  const sealed = sealDurableShareSnapshot({
    shareId, epoch: 0, fileId, snapshotId, docType: 'markdown', content: '# Live browser owner\n',
    snapshotKey: room.keys.readKeys.snapshotKey,
  });
  await client.uploadSnapshot(fileId, snapshotId, sealed);
  sealed.fill(0);
  const retained = await client.fetchWithViewCapability(shareSecret);
  check(retained.revision === 1 && retained.snapshots.length === 1, 'relay retains opaque snapshot and advances revision');
  const finalRevision = retained.revision + 1;
  const active = await client.upsert({
    v: 3, ownerSigningKey: retained.ownerSigningKey,
    bundles: buildShareBundleMutations(context(finalRevision, retained.manifestDigest)),
    epoch: 0, revision: finalRevision, currentRoomId: room.roomId,
    snapshots: retained.snapshots, placeholders: retained.placeholders,
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
  const opened = decryptDurableShareSnapshot(shareId, 0, {
    v: 3, shareId, bundleId: bundle.bundleId, epoch: 0, revision: finalRevision,
    manifestDigest: active.manifestDigest, roomId: room.roomId, tier: 'view',
    roomCapability: { ownerSigningKey: bundle.ownerSigningKey,
      readCapabilityKey: room.keys.readKeys.readCapabilityKey, roomKeys: room.keys.readKeys },
  }, fileId, snapshotId, downloaded);
  check(opened.content === '# Live browser owner\n', 'view bearer resolves and decrypts browser-owned snapshot');

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
