#!/usr/bin/env node
// Real-relay proof for attn-7xl.4.3's native-compatible browser publisher.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const port = 8792;
const relayUrl = `http://127.0.0.1:${port}`;
const { createOwnedRoom, deleteOwnedRoom } = await import(path.join(webRoot, 'src/lib/review/browser-owner-bootstrap.ts'));
const { BrowserOutbox } = await import(path.join(webRoot, 'src/lib/review/browser-outbox.ts'));
const { publishBrowserSnapshots } = await import(path.join(webRoot, 'src/lib/review/browser-snapshot-publisher.ts'));
const { mineBrowserPow } = await import(path.join(webRoot, 'src/lib/review/browser-pow.ts'));

function mintPow(input) {
  const rand = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  return Promise.resolve(mineBrowserPow({ ...input, expiresAt: Date.now() + 60_000, rand }).token);
}
async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${relayUrl}/health`)).ok) return; } catch { /* poll */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('relay did not become healthy');
}

const relay = spawn(path.join(relayRoot, 'node_modules', '.bin', 'wrangler'), [
  'dev', '--env', 'staging', '--local', '--port', String(port),
  '--var', 'QUOTA_ALLOW_UNATTRIBUTED_CREATES:true',
  '--var', 'BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes',
], { cwd: relayRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
relay.stdout.on('data', (chunk) => (log += chunk));
relay.stderr.on('data', (chunk) => (log += chunk));

try {
  await ready();
  const owned = await createOwnedRoom({ relayUrl, mintPow });
  const outbox = new BrowserOutbox({
    relayUrl, roomId: owned.roomId, deviceId: owned.identity.deviceId,
    admissionKey: owned.keys.admissionKey, powBits: owned.policy.powBits,
    maxEventBytes: owned.policy.maxEventBytes,
    maxSnapshotBytes: owned.policy.maxSnapshotBytes,
    mintPow,
  });
  const [published] = await publishBrowserSnapshots({
    relayUrl, roomId: owned.roomId, roomSecret: owned.roomSecret,
    keys: owned.keys, identity: owned.identity, policy: owned.policy, outbox,
    entries: [{ path: 'live-proof.md', bytes: new TextEncoder().encode('# Browser-owned\n\nEncrypted snapshot.\n'), docType: 'markdown' }],
  });
  if (!published || published.blobRef.storage !== 'mailbox' || outbox.getState().pendingCount !== 0) {
    throw new Error('relay did not durably acknowledge blob + signed pointer');
  }
  console.log('PASS real relay accepted browser snapshot_blob then signed SnapshotCreated');
  await deleteOwnedRoom({
    relayUrl, roomId: owned.roomId, identity: owned.identity,
    admissionKey: owned.keys.admissionKey, mintPow,
  });
  outbox.close();
} catch (error) {
  console.error('FAIL live snapshot publish:', error);
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  relay.kill('SIGTERM');
}
