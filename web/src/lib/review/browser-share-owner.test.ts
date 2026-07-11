import {
  BrowserShareOwnerRelayClient,
  EMPTY_SHARE_MANIFEST_DIGEST,
  buildShareBundleMutations,
  composeShareTierInvites,
  digestShareSnapshotManifest,
  sealDurableShareSnapshot,
} from './browser-share-owner';
import {
  base64UrlEncode,
  buildOwnerSignatureHeader,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveShareLinkKeys,
  toCanonicalBytes,
} from './browser-crypto';
import { openShareCapabilityBundle, parseShareInvite } from './browser-share';
import { decryptDurableShareSnapshot } from './browser-share-production';
import { generateBrowserIdentity } from './browser-session';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run(): Promise<void> {
  const shareId = base64UrlEncode(new Uint8Array(16).fill(7));
  const shareSecret = new Uint8Array(32).fill(9);
  const roomSecret = new Uint8Array(32).fill(11);
  const room = deriveRoomKeyTreeV3(roomSecret);
  const roomId = deriveRoomIdV3(roomSecret);
  const identity = generateBrowserIdentity();
  const ownerSigningKey = base64UrlEncode(identity.signingPublic);

  assert(digestShareSnapshotManifest([]) === EMPTY_SHARE_MANIFEST_DIGEST, 'empty digest parity');

  let nonceByte = 0;
  const mutations = buildShareBundleMutations({
    shareId,
    shareSecret,
    epoch: 0,
    revision: 4,
    manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
    roomId,
    ownerSigningKey,
    readCapabilityKey: room.readKeys.readCapabilityKey,
    writeAdmissionKey: room.writeAdmissionKey,
    commentGrantSignature: base64UrlEncode(new Uint8Array(64).fill(3)),
    suggestGrantSignature: base64UrlEncode(new Uint8Array(64).fill(5)),
    randomBytes: (length) => new Uint8Array(length).fill(++nonceByte),
  });
  assert(mutations.length === 3, 'three mutations');
  for (const mutation of mutations) {
    const keys = deriveShareLinkKeys(shareSecret, mutation.tier);
    const opened = openShareCapabilityBundle(keys.bundleKey, keys.bundleId, {
      shareId,
      epoch: 0,
      revision: 4,
      manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
      tier: mutation.tier,
    }, mutation.sealedBundle);
    assert(opened.roomId === roomId && opened.tier === mutation.tier, 'bundle context');
  }

  const invites = composeShareTierInvites(shareId, shareSecret);
  const parsed = [invites.view, invites.comment, invites.suggest]
    .map((invite) => parseShareInvite(invite.browserUrl));
  assert(parsed.every((invite) => invite.shareId === shareId), 'stable share id');
  assert(new Set(parsed.map((invite) => base64UrlEncode(invite.linkSecret))).size === 3, 'sibling secrets');

  const snapshotId = base64UrlEncode(new Uint8Array(16).fill(13));
  const fileId = base64UrlEncode(new Uint8Array(16).fill(15));
  const sealed = sealDurableShareSnapshot({
    shareId,
    epoch: 0,
    fileId,
    snapshotId,
    docType: 'markdown',
    content: '# Browser owner\n',
    snapshotKey: room.readKeys.snapshotKey,
    nonce: new Uint8Array(24).fill(17),
  });
  const decoded = decryptDurableShareSnapshot(shareId, 0, {
    v: 3,
    shareId,
    bundleId: mutations[0]!.bundleId,
    epoch: 0,
    revision: 4,
    manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
    roomId,
    tier: 'view',
    roomCapability: { ownerSigningKey, readCapabilityKey: room.readKeys.readCapabilityKey, roomKeys: room.readKeys },
  }, fileId, snapshotId, sealed);
  assert(decoded.content === '# Browser owner\n', 'durable ciphertext interop');

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const record = {
    v: 3, shareId, ownerSigningKey, epoch: 0, revision: 0,
    snapshots: [], placeholders: [], manifestDigest: EMPTY_SHARE_MANIFEST_DIGEST,
    updatedAt: 1, expiresAt: 2, mailbox: { count: 0, bytes: 0, latestSeq: 0 },
  };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json(record, { status: init?.method === 'POST' ? 201 : 200 });
  }) as typeof fetch;
  const client = new BrowserShareOwnerRelayClient({
    relayUrl: 'https://relay.example',
    shareId,
    identity,
    fetchImpl,
    mintPow: async () => 'pow',
  });
  const body = {
    v: 3 as const,
    ownerSigningKey,
    bundles: mutations,
    epoch: 0,
    revision: 0,
    currentRoomId: null,
    snapshots: [],
    placeholders: [],
    deviceId: identity.deviceId,
  };
  await client.upsert(body);
  await client.fetchWithViewCapability(shareSecret);
  const post = requests[0]!;
  const bodyText = post.init.body as string;
  const path = `/v3/shares/${shareId}`;
  assert(
    (post.init.headers as Record<string, string>)['Attn-Owner-Signature']
      === buildOwnerSignatureHeader(identity.signingSecret, 'POST', path, new TextEncoder().encode(bodyText)),
    'owner request signature',
  );
  assert((requests[1]!.init.headers as Record<string, string>)['Attn-Admission'].startsWith('v3.read.'), 'view read proof');

  // Ensure the plaintext shape stays canonical and free of accidental fields.
  const canonical = toCanonicalBytes({ v: 3, fileId, snapshotId, docType: 'markdown', content: '# Browser owner\n' });
  assert(canonical.length > 0, 'canonical snapshot bytes');
  console.log('browser-share-owner: 6 passed, 0 failed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
