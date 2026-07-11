#!/usr/bin/env node
// Real-relay proof for attn-7xl.4.3's native-compatible browser publisher.
//
// This deliberately uses the production browser protocol pieces against a
// local wrangler instance of the real relay. It proves that a mixed workspace
// is accepted and replayed in order, that small snapshots use the mailbox,
// that an oversized opaque asset uses the R2 capability flow, and that the
// relay-visible representation contains no workspace plaintext.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWebSocket } from 'ws';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = path.resolve(webRoot, '..', 'relay');
const port = 8792;
const relayUrl = `http://127.0.0.1:${port}`;
const { createOwnedRoom, deleteOwnedRoom } = await import(
  path.join(webRoot, 'src/lib/review/browser-owner-bootstrap.ts')
);
const { BrowserOutbox } = await import(path.join(webRoot, 'src/lib/review/browser-outbox.ts'));
const { publishBrowserSnapshots } = await import(
  path.join(webRoot, 'src/lib/review/browser-snapshot-publisher.ts')
);
const { resolveBrowserR2Snapshot, uploadBrowserR2Snapshot } = await import(
  path.join(webRoot, 'src/lib/review/browser-snapshot-r2.ts')
);
const {
  BrowserWsClient,
  buildWsUrl,
  socketPath,
} = await import(path.join(webRoot, 'src/lib/review/browser-ws.ts'));
const {
  buildAdmissionSubprotocol,
  contentHash,
} = await import(path.join(webRoot, 'src/lib/review/browser-crypto.ts'));
const {
  decodeCanonicalBase64Url,
  validateSnapshotPlaintext,
} = await import(path.join(webRoot, 'src/lib/review/browser-workspace-manifest.ts'));
const { mineBrowserPow } = await import(path.join(webRoot, 'src/lib/review/browser-pow.ts'));

const markdownPath = 'docs/nested/guide.md';
const assetPath = 'assets/opaque.bin';
const markdownText = [
  '# Browser relay proof',
  '',
  '## Nested section',
  '',
  '- parent',
  '  - child with marker LIVE-NESTED-MARKDOWN-4.3.1',
  '',
  '```txt',
  'mailbox and R2 stay encrypted',
  '```',
  '',
].join('\n');
const markdownBytes = new TextEncoder().encode(markdownText);
// Above the browser publisher's 1 MiB spill threshold and intentionally full
// of NULs/invalid UTF-8 sequences. The deterministic pattern makes the exact
// byte-for-byte round trip independently checkable without fixture files.
const assetBytes = new Uint8Array(1024 * 1024 + 65_537);
let prng = 0x6d2b79f5;
for (let i = 0; i < assetBytes.length; i += 1) {
  prng ^= prng << 13;
  prng ^= prng >>> 17;
  prng ^= prng << 5;
  assetBytes[i] = prng & 0xff;
}
assetBytes.set([0x00, 0xff, 0xfe, 0x80, 0xc0, 0xf5, 0x00], 257);

function mintPow(input) {
  const rand = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  return Promise.resolve(mineBrowserPow({ ...input, expiresAt: Date.now() + 60_000, rand }).token);
}

async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${relayUrl}/health`)).ok) return;
    } catch {
      // poll
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('relay did not become healthy');
}

function check(condition, label) {
  if (!condition) throw new Error(label);
  console.log(`PASS ${label}`);
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function nodeWebSocketFactory(url, protocols) {
  const socket = new NodeWebSocket(url, protocols);
  const wrapped = {
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on('open', () => wrapped.onopen?.({}));
  socket.on('message', (data, isBinary) => {
    wrapped.onmessage?.({ data: isBinary ? data : data.toString('utf8') });
  });
  socket.on('close', (code, reason) => {
    wrapped.onclose?.({ code, reason: reason.toString('utf8') });
  });
  socket.on('error', (error) => wrapped.onerror?.(error));
  return wrapped;
}

async function replayRoom(owned, expectedCount) {
  const decoded = [];
  const errors = [];
  let helloSeq = null;
  let resolveComplete;
  let rejectComplete;
  const complete = new Promise((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  const pathName = socketPath(owned.roomId);
  const client = new BrowserWsClient({
    roomId: owned.roomId,
    localDeviceId: owned.identity.deviceId,
    url: buildWsUrl(relayUrl, owned.roomId, owned.identity.deviceId),
    subprotocol: buildAdmissionSubprotocol(owned.keys.admissionKey, 'GET', pathName, [
      ['device_id', owned.identity.deviceId],
    ]),
    afterSeq: 0,
    eventKey: owned.keys.eventKey,
    snapshotKey: owned.keys.snapshotKey,
    signalingKey: owned.keys.signalingKey,
    webSocketFactory: nodeWebSocketFactory,
    callbacks: {
      onHello(frame) {
        helloSeq = frame.serverSeq;
      },
      onEnvelope(value) {
        decoded.push({
          envelope: value.envelope,
          serverSeq: value.serverSeq,
          plaintext: new Uint8Array(value.plaintext),
        });
        if (decoded.length === expectedCount) resolveComplete();
      },
      onError(code, message) {
        errors.push(`${code}: ${message}`);
      },
      onTerminal(error) {
        rejectComplete(error);
      },
    },
  });
  client.start();
  let timer;
  try {
    await Promise.race([
      complete,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for relay replay')), 30_000);
      }),
    ]);
    // onEnvelope callbacks are serialized and the cursor advances after each
    // callback returns, so one microtask lets the last commit settle.
    await Promise.resolve();
    return { decoded, errors, helloSeq, afterSeq: client.getAfterSeq() };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

const relay = spawn(path.join(relayRoot, 'node_modules', '.bin', 'wrangler'), [
  'dev',
  '--env',
  'staging',
  '--local',
  '--port',
  String(port),
  '--var',
  'QUOTA_ALLOW_UNATTRIBUTED_CREATES:true',
  '--var',
  'BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes',
], { cwd: relayRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
relay.stdout.on('data', (chunk) => (log += chunk));
relay.stderr.on('data', (chunk) => (log += chunk));

let outbox;
let owned;
try {
  await ready();
  // Node cannot fetch file: URLs. Seed the generated web-target module from
  // its checked-in bytes; the publisher then uses its normal lazy loader,
  // whose idempotent init resolves this exact module instance.
  const anchorWasm = await import(
    path.join(webRoot, 'src/lib/review/anchor-wasm-pkg/attn_anchor_wasm.js')
  );
  await anchorWasm.default({
    module_or_path: readFileSync(
      path.join(webRoot, 'src/lib/review/anchor-wasm-pkg/attn_anchor_wasm_bg.wasm'),
    ),
  });
  owned = await createOwnedRoom({ relayUrl, mintPow });
  const acknowledged = [];
  outbox = new BrowserOutbox({
    relayUrl,
    roomId: owned.roomId,
    deviceId: owned.identity.deviceId,
    admissionKey: owned.keys.admissionKey,
    powBits: owned.policy.powBits,
    maxEventBytes: owned.policy.maxEventBytes,
    maxSnapshotBytes: owned.policy.maxSnapshotBytes,
    mintPow,
    onAccepted: (batch) => acknowledged.push(...batch),
  });
  let committed = null;
  let pendingAtCommit = null;
  let staged = null;
  const results = await publishBrowserSnapshots({
    relayUrl,
    roomId: owned.roomId,
    roomSecret: owned.roomSecret,
    keys: owned.keys,
    identity: owned.identity,
    policy: owned.policy,
    outbox,
    // Node has no browser Worker global; keep the production upload path and
    // inject only the same inline PoW miner used by this live relay harness.
    uploadR2: (options) => uploadBrowserR2Snapshot({ ...options, mintPow }),
    entries: [
      { path: markdownPath, bytes: markdownBytes, docType: 'markdown' },
      { path: assetPath, bytes: assetBytes, docType: 'asset', mediaType: 'application/octet-stream' },
    ],
    publication: {
      workspaceId: 'live-workspace',
      capId: 'live-capability',
      sink: {
        async loadPublishedManifest() {
          return committed?.pointer;
        },
        async stagePublication(workspaceId, capId, pointer, envelopes) {
          staged = {
            workspaceId,
            capId,
            pointer,
            envelopes: envelopes.map((envelope) => structuredClone(envelope)),
          };
        },
        async loadPendingPublication(workspaceId, capId) {
          if (!staged) return [];
          check(
            staged.workspaceId === workspaceId && staged.capId === capId,
            'staged publication is workspace/capability bound',
          );
          return staged.envelopes;
        },
        async commitPublication(workspaceId, capId) {
          if (!staged) throw new Error('publication committed without a staged journal');
          pendingAtCommit = outbox.getState().pendingCount;
          committed = { workspaceId, capId, pointer: staged.pointer };
          staged = null;
        },
      },
    },
  });

  const assetResult = results.find((result) => result.path === assetPath);
  const markdownResult = results.find((result) => result.path === markdownPath);
  const manifestResult = results.at(-1);
  check(results.length === 3, 'publisher produced two entries plus one workspace manifest');
  check(assetResult?.blobRef.storage === 'r2', 'oversized arbitrary binary asset used real R2 upload');
  check(markdownResult?.blobRef.storage === 'mailbox', 'nested Markdown used the mailbox snapshot lane');
  check(
    manifestResult?.kind === 'workspace_manifest' && manifestResult.blobRef.storage === 'mailbox',
    'workspace manifest was published last on the mailbox lane',
  );
  check(
    outbox.getState().pendingCount === 0 && pendingAtCommit === 0 && acknowledged.length === 6,
    'all six sealed envelopes were acknowledged before the publication pointer committed',
  );
  check(
    committed?.workspaceId === 'live-workspace' && committed?.capId === 'live-capability',
    'publication committed through the workspace/capability boundary',
  );
  check(
    committed?.pointer.manifestSnapshotId === manifestResult.snapshotId &&
      committed.pointer.entries.map((entry) => entry.path).join('|') === `${assetPath}|${markdownPath}`,
    'sealed publication pointer references the final manifest and UTF-8-sorted entries',
  );

  const replay = await replayRoom(owned, acknowledged.length);
  check(replay.errors.length === 0, 'mailbox replay decrypted and verified without protocol errors');
  check(replay.helloSeq === 6 && replay.afterSeq === 6, 'mailbox replay advanced through server sequence 1..6');
  check(
    replay.decoded.every((value, index) => value.serverSeq === index + 1),
    'relay preserved entry wrapper/event ordering and manifest-last ordering',
  );
  check(
    replay.decoded.every((value, index) => value.envelope.envelopeId === acknowledged[index].envelopeId),
    'relay replayed the exact accepted encrypted envelopes in publication order',
  );

  const relayVisible = replay.decoded.map(({ envelope }) => JSON.stringify(envelope)).join('\n');
  const assetBase64Prefix = Buffer.from(assetBytes.subarray(0, 96)).toString('base64url');
  check(
    !relayVisible.includes('LIVE-NESTED-MARKDOWN-4.3.1') &&
      !relayVisible.includes(markdownPath) &&
      !relayVisible.includes(assetPath) &&
      !relayVisible.includes(assetBase64Prefix) &&
      !relayVisible.includes('attn_workspace_snapshot'),
    'relay-visible replay is content-blind ciphertext (no paths, Markdown, asset bytes, or manifest schema)',
  );

  const snapshotFrames = replay.decoded.filter((value) => value.envelope.kind === 'snapshot_blob');
  check(snapshotFrames.length === 3, 'relay replay contained one encrypted snapshot wrapper per publication item');
  check(
    snapshotFrames.map((value) => value.envelope.envelopeId).join('|') ===
      results.map((result) => result.blobRef.blobId).join('|'),
    'snapshot wrapper order matches sorted asset, nested Markdown, then final manifest',
  );

  const recoveredByBlobId = new Map();
  for (const frame of snapshotFrames) {
    const result = results.find((item) => item.blobRef.blobId === frame.envelope.envelopeId);
    if (!result) throw new Error('replayed an unknown snapshot wrapper');
    if (result.blobRef.storage === 'r2') {
      recoveredByBlobId.set(
        result.blobRef.blobId,
        await resolveBrowserR2Snapshot({
          relayUrl,
          roomId: owned.roomId,
          admissionKey: owned.keys.admissionKey,
          snapshotKey: owned.keys.snapshotKey,
          wrapper: frame.envelope,
          fetchImpl: fetch,
        }),
      );
    } else {
      recoveredByBlobId.set(result.blobRef.blobId, frame.plaintext);
    }
  }

  const assetPlaintext = validateSnapshotPlaintext(JSON.parse(new TextDecoder().decode(
    recoveredByBlobId.get(assetResult.blobRef.blobId),
  )));
  check(assetPlaintext.docType === 'asset', 'R2 ciphertext resolved to the strict asset payload');
  const recoveredAsset = decodeCanonicalBase64Url(assetPlaintext.content);
  check(
    equalBytes(recoveredAsset, assetBytes) && contentHash(recoveredAsset) === assetResult.baseHash,
    'R2 asset round-tripped every arbitrary binary byte and matched its signed content hash',
  );
  recoveredAsset.fill(0);

  const markdownPlaintext = validateSnapshotPlaintext(JSON.parse(new TextDecoder().decode(
    recoveredByBlobId.get(markdownResult.blobRef.blobId),
  )));
  check(
    markdownPlaintext.docType === 'markdown' &&
      markdownPlaintext.content === markdownText &&
      markdownPlaintext.anchorIndex?.blocks.length > 0,
    'mailbox Markdown round-tripped with the canonical Rust/WASM anchor index',
  );

  const manifestPlaintext = validateSnapshotPlaintext(JSON.parse(new TextDecoder().decode(
    recoveredByBlobId.get(manifestResult.blobRef.blobId),
  )));
  check(
    manifestPlaintext.docType === 'workspace_manifest' &&
      manifestPlaintext.manifest.scope === 'workspace' &&
      manifestPlaintext.manifest.entries.length === 2,
    'final mailbox payload is a strict workspace manifest for both entries',
  );
  const manifestEntries = manifestPlaintext.manifest.entries;
  check(
    manifestEntries[0].path === assetPath &&
      manifestEntries[0].snapshotId === assetResult.snapshotId &&
      manifestEntries[0].contentHash === assetResult.baseHash &&
      manifestEntries[0].byteLength === assetBytes.length &&
      manifestEntries[1].path === markdownPath &&
      manifestEntries[1].snapshotId === markdownResult.snapshotId &&
      manifestEntries[1].contentHash === markdownResult.baseHash &&
      manifestEntries[1].byteLength === markdownBytes.length,
    'manifest entries exactly bind sorted paths, snapshot IDs, raw byte lengths, and content hashes',
  );

  for (const value of recoveredByBlobId.values()) value.fill(0);
  for (const value of replay.decoded) value.plaintext.fill(0);
  console.log('browser-snapshot-publish-live: all green');
} catch (error) {
  console.error('FAIL live snapshot publish:', error);
  console.error(log.split('\n').slice(-35).join('\n'));
  process.exitCode = 1;
} finally {
  if (owned) {
    try {
      await deleteOwnedRoom({
        relayUrl,
        roomId: owned.roomId,
        identity: owned.identity,
        admissionKey: owned.keys.admissionKey,
        mintPow,
      });
    } catch (error) {
      console.error('FAIL live room teardown:', error);
      process.exitCode = 1;
    }
  }
  outbox?.close();
  relay.kill('SIGTERM');
  assetBytes.fill(0);
  markdownBytes.fill(0);
}
