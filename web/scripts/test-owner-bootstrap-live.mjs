#!/usr/bin/env node
// Live owner-bootstrap integration proof (attn-7xl.4.1): runs the browser
// owner room create/rejoin/register/delete flow against the REAL relay
// (miniflare via `wrangler dev --local` in ../relay). The relay's own
// admission, owner-signature, and PoW verification are the referee — if any
// canonical byte differed from the native protocol, these calls would 401.
//
// Usage: node scripts/test-owner-bootstrap-live.mjs
//   (starts its own relay on a scratch port; ~30s)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// tsx registers itself when this script is run via `tsx` — see the npm
// script; plain `node` cannot import the .ts modules below.

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const PORT = 8791;
const RELAY = `http://127.0.0.1:${PORT}`;

const { createOwnedRoom, deleteOwnedRoom } = await import(
  path.join(webRoot, 'src/lib/review/browser-owner-bootstrap.ts')
);
const { mineBrowserPow } = await import(path.join(webRoot, 'src/lib/review/browser-pow.ts'));
const { buildAdmissionHeader } = await import(path.join(webRoot, 'src/lib/review/browser-crypto.ts'));

function inlineMintPow(input) {
  const rand = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const mined = mineBrowserPow({ ...input, expiresAt: Date.now() + 60_000, rand });
  return Promise.resolve(mined.token);
}

async function waitForRelay(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${RELAY}/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('relay did not become healthy');
}

const relay = spawn(
  path.join(relayRoot, 'node_modules', '.bin', 'wrangler'),
  [
    'dev',
    '--env',
    'staging',
    '--local',
    '--port',
    String(PORT),
    '--var',
    'QUOTA_ALLOW_UNATTRIBUTED_CREATES:true',
    '--var',
    'BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes',
  ],
  { cwd: relayRoot, stdio: ['ignore', 'pipe', 'pipe'] },
);
let relayLog = '';
relay.stdout.on('data', (chunk) => (relayLog += chunk));
relay.stderr.on('data', (chunk) => (relayLog += chunk));

let failures = 0;
function check(condition, label) {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

try {
  await waitForRelay(60_000);

  // First create: the relay verifies owner signature + admission + PoW.
  const first = await createOwnedRoom({ relayUrl: RELAY, mintPow: inlineMintPow });
  check(first.created === true, 'first create returns 201 (owner sig + admission + PoW accepted)');

  // Idempotent rejoin with the same secret + identity.
  const rejoin = await createOwnedRoom({
    relayUrl: RELAY,
    mintPow: inlineMintPow,
    roomSecret: first.roomSecret,
    identity: first.identity,
  });
  check(rejoin.created === false, 'rejoin with the same secret returns 200');
  check(rejoin.roomId === first.roomId, 'room id is deterministic from the secret');

  // The owner device is in the directory.
  const devicesPath = `/v2/rooms/${first.roomId}/devices`;
  const devicesResponse = await fetch(`${RELAY}${devicesPath}`, {
    headers: {
      'Attn-Admission': buildAdmissionHeader(
        first.keys.admissionKey,
        'GET',
        devicesPath,
        new Uint8Array(0),
      ),
    },
  });
  const devices = await devicesResponse.json();
  const owner = devices.devices?.find((device) => device.kind === 'owner');
  check(devicesResponse.status === 200, 'device directory readable with admission');
  check(Boolean(owner), 'owner device registered');
  check(owner?.client === 'attn-browser', 'owner client is attn-browser');

  // Owner-signed DELETE tears the room down.
  const deleted = await deleteOwnedRoom({
    relayUrl: RELAY,
    roomId: first.roomId,
    identity: first.identity,
    admissionKey: first.keys.admissionKey,
    mintPow: inlineMintPow,
  });
  check(deleted, 'owner-signed DELETE accepted');
} catch (error) {
  failures += 1;
  console.error('FAIL live bootstrap:', error);
  console.error('relay log tail:\n' + relayLog.split('\n').slice(-25).join('\n'));
} finally {
  relay.kill('SIGTERM');
}

console.log(failures === 0 ? 'owner-bootstrap-live: all green' : `owner-bootstrap-live: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
