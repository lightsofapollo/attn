import { base64UrlEncode } from './browser-crypto';
import { composeShareInvite, deriveShareRoomSecret, parseShareInvite } from './browser-share';

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

test('native and browser durable share URLs round-trip', () => {
  for (const url of [
    composeShareInvite(shareId, secret),
    composeShareInvite(shareId, secret, 'https://attn.sh'),
  ]) {
    const parsed = parseShareInvite(url);
    assert(parsed.shareId === shareId, 'shareId mismatch');
    assert(base64UrlEncode(parsed.shareSecret) === base64UrlEncode(secret), 'secret mismatch');
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

test('successive epochs are stable and distinct', () => {
  const parsed = parseShareInvite(composeShareInvite(shareId, new Uint8Array(32)));
  const epoch0 = deriveShareRoomSecret(parsed, 0);
  const epoch1 = deriveShareRoomSecret(parsed, 1);
  assert(base64UrlEncode(epoch0) !== base64UrlEncode(epoch1), 'epoch collision');
  assert(
    base64UrlEncode(epoch0) === base64UrlEncode(deriveShareRoomSecret(parsed, 0)),
    'epoch derivation not stable',
  );
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
