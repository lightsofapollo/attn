import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64UrlDecode, base64UrlEncode, deriveRoomIdV3, deriveRoomKeyTreeV3, deriveShareEpochRoomSecret, deriveShareLinkKeys, type ShareLinkTier } from './browser-crypto';
import { composeShareInvite, deriveInviteLinkKeys, openShareCapabilityBundle, parseShareInvite, sealShareCapabilityBundle, type ShareCapabilityBundle } from './browser-share';

let passed = 0;
function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  not ok  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const shareId = 'AAECAwQFBgcICQoLDA0ODw';
const secret = new Uint8Array(32).fill(0x42);
const here = dirname(fileURLToPath(import.meta.url));

interface CapabilityVector {
  tier: ShareLinkTier;
  linkSecret: string;
  bundleKey: string;
  bundleId: string;
  readAdmissionKey: string;
  writeAdmissionKey?: string;
  nonce?: string;
  bundle?: ShareCapabilityBundle;
  sealedBundle?: string;
}

const corpus = JSON.parse(readFileSync(resolvePath(
  here,
  '../../../../planning/collab/test-vectors/share-capabilities-v3.json',
), 'utf8')) as { version: number; shareSecret: string; shareId: string; epoch: number; vectors: CapabilityVector[] };

test('native and browser durable share URLs round-trip', () => {
  for (const url of [
    composeShareInvite(shareId, secret),
    composeShareInvite(shareId, secret, 'https://attn.sh'),
  ]) {
    const parsed = parseShareInvite(url);
    assert(parsed.shareId === shareId, 'shareId mismatch');
    assert(base64UrlEncode(parsed.linkSecret) === base64UrlEncode(secret), 'link secret mismatch');
  }
});

test('strict parser rejects ambiguous and noncanonical forms', () => {
  const encoded = base64UrlEncode(secret);
  for (const invalid of [
    `attn://share/short#key=${encoded}`,
    `attn://share/${shareId}#other=${encoded}`,
    `attn://share/${shareId}#key=${encoded}&x=1`,
    `http://attn.sh/s/${shareId}#key=${encoded}`,
    `https://attn.sh/s/${shareId}/extra#key=${encoded}`,
    `https://evil.example/s/${shareId}#key=${encoded}`,
    `https://attn.sh/s/${shareId}?ignored=1#key=${encoded}`,
    `attn://user:pass@share/${shareId}#key=${encoded}`,
    `attn://share/${shareId}?ignored=1#key=${encoded}`,
    `attn://share/${shareId}?#key=${encoded}`,
    `https://attn.sh:443/s/${shareId}#key=${encoded}`,
  ]) {
    let rejected = false;
    try { parseShareInvite(invalid); } catch { rejected = true; }
    assert(rejected, `accepted ${invalid}`);
  }
});

test('owner root derives distinct tier links and URL recipient expands only link leaves', () => {
  const ownerRoot = new Uint8Array(32);
  const links = ['view', 'comment', 'suggest'].map(tier => deriveShareLinkKeys(ownerRoot, tier as 'view' | 'comment' | 'suggest'));
  assert(new Set(links.map(link => base64UrlEncode(link.linkSecret))).size === 3, 'tier link collision');
  assert(links[0]!.writeAdmissionKey === undefined, 'view unexpectedly writable');
  assert(links[1]!.writeAdmissionKey !== undefined && links[2]!.writeAdmissionKey !== undefined, 'writable tier missing key');
  const parsed = parseShareInvite(composeShareInvite(shareId, links[1]!.linkSecret));
  const expanded = deriveInviteLinkKeys(parsed, 'comment');
  assert(expanded.bundleId === links[1]!.bundleId, 'bundle id mismatch');
  assert(base64UrlEncode(expanded.bundleKey) === base64UrlEncode(links[1]!.bundleKey), 'bundle key mismatch');
});

test('sealed bundle binds share, epoch, tier, and exact v3 room capabilities', () => {
  const shareRoot = new Uint8Array(32);
  const epoch = 7;
  const roomSecret = deriveShareEpochRoomSecret(shareRoot, epoch);
  const room = deriveRoomKeyTreeV3(roomSecret);
  const link = deriveShareLinkKeys(shareRoot, 'comment');
  const bundle: ShareCapabilityBundle = {
    v: 3,
    purpose: 'attn share capability bundle v3',
    bundleId: link.bundleId,
    ownerSigningKey: base64UrlEncode(new Uint8Array(32).fill(1)),
    shareId,
    epoch,
    revision: 0,
    manifestDigest: 'T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU',
    tier: 'comment',
    roomId: deriveRoomIdV3(roomSecret),
    readCapabilityKey: base64UrlEncode(room.readKeys.readCapabilityKey),
    writeAdmissionKey: base64UrlEncode(room.writeAdmissionKey),
    grantSignature: base64UrlEncode(new Uint8Array(64).fill(2)),
  };
  const sealed = sealShareCapabilityBundle(link.bundleKey, link.bundleId, bundle, new Uint8Array(24));
  const expected = { shareId, epoch, revision: 0, manifestDigest: bundle.manifestDigest, tier: 'comment' as const };
  const opened = openShareCapabilityBundle(link.bundleKey, link.bundleId, expected, sealed);
  assert(opened.roomId === bundle.roomId, 'room mismatch');
  let rejected = false;
  try { openShareCapabilityBundle(link.bundleKey, link.bundleId, { ...expected, tier: 'suggest' }, sealed); }
  catch { rejected = true; }
  assert(rejected, 'tier substitution accepted');
});

test('shared capability corpus reproduces tier KDF and sealed bundles byte-for-byte', () => {
  assert(corpus.version === 2 && corpus.vectors.length === 3, 'corpus shape');
  const root = base64UrlDecode(corpus.shareSecret);
  for (const vector of corpus.vectors) {
    const keys = deriveShareLinkKeys(root, vector.tier);
    assert(base64UrlEncode(keys.linkSecret) === vector.linkSecret, `${vector.tier} link`);
    assert(base64UrlEncode(keys.bundleKey) === vector.bundleKey, `${vector.tier} bundle key`);
    assert(keys.bundleId === vector.bundleId, `${vector.tier} bundle id`);
    assert(base64UrlEncode(keys.readAdmissionKey) === vector.readAdmissionKey, `${vector.tier} read admission`);
    assert(
      (keys.writeAdmissionKey === undefined ? undefined : base64UrlEncode(keys.writeAdmissionKey)) === vector.writeAdmissionKey,
      `${vector.tier} write admission`,
    );
    if (vector.bundle !== undefined && vector.nonce !== undefined && vector.sealedBundle !== undefined) {
      assert(
        sealShareCapabilityBundle(keys.bundleKey, keys.bundleId, vector.bundle, base64UrlDecode(vector.nonce)) === vector.sealedBundle,
        `${vector.tier} sealed bytes`,
      );
      const opened = openShareCapabilityBundle(keys.bundleKey, keys.bundleId, {
        shareId: corpus.shareId,
        epoch: corpus.epoch,
        revision: vector.bundle.revision,
        manifestDigest: vector.bundle.manifestDigest,
        tier: vector.tier,
      }, vector.sealedBundle);
      assert(opened.roomId === vector.bundle.roomId, `${vector.tier} opened room`);
    }
  }
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
