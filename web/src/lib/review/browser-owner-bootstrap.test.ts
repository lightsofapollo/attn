import { ed25519 } from '@noble/curves/ed25519.js';
import {
  OwnerBootstrapError,
  createOwnedRoom,
  createOwnedRoomV3,
  defaultOwnerPolicy,
  deleteOwnedRoom,
  deleteOwnedRoomV3,
} from './browser-owner-bootstrap';
import {
  base64UrlDecode,
  buildAdmissionHeader,
  buildAdmissionHeaderV3,
  buildOwnerSignatureHeader,
  deriveRoomId,
  deriveRoomIdV3,
  deriveRoomKeyTreeV3,
  deriveRoomKeys,
} from './browser-crypto';
import { generateBrowserIdentity } from './browser-session';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void | string> | void | string): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubRelay(handlers: {
  createStatus?: number;
  registerStatus?: number;
  deleteStatus?: number;
}): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (method === 'POST' && /\/v[23]\/rooms\/[^/]+$/u.test(url)) {
      const status = handlers.createStatus ?? 201;
      return new Response(
        JSON.stringify({
          roomId: url.split('/').pop(),
          createdAt: 1,
          expiresAt: 2,
          policy: {},
          ownerSigningKeyId: 'x',
          serverSeq: 0,
        }),
        { status },
      );
    }
    if (method === 'POST' && url.endsWith('/devices')) {
      return new Response(null, { status: handlers.registerStatus ?? 204 });
    }
    if (method === 'DELETE') {
      return new Response(null, { status: handlers.deleteStatus ?? 204 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const RELAY = 'https://relay.example';
const mintPow = async (): Promise<string> => 'pow-token-stub';

defineCase('create sends the exact native wire shape with verifiable headers', async () => {
  const { fetchImpl, requests } = stubRelay({});
  const result = await createOwnedRoom({
    relayUrl: RELAY,
    fetchImpl,
    mintPow,
    now: () => 1_700_000_000_000,
  });

  assertEqual(requests.length, 2, 'create then register');
  const create = requests[0]!;
  assertEqual(create.method, 'POST', 'create method');
  assertEqual(create.url, `${RELAY}/v2/rooms/${result.roomId}`, 'create url');

  const body = JSON.parse(create.body);
  assertEqual(body.v, 2, 'protocol version');
  assertEqual(body.policy.mode, 'hybrid', 'default mode');
  assertEqual(body.policy.maxPeers, 8, 'bounded peers');
  assertEqual(body.policy.allowBrowser, true, 'browser allowed');
  assertEqual(body.policy.powBits, 12, 'pow bits');
  assertEqual(body.policy.idleTimeoutMs, 3_600_000, 'idle timeout');
  assertEqual(body.policy.longSession, false, 'no long session');
  assertEqual(
    body.policy.expiresAt,
    1_700_000_000_000 + 24 * 3_600_000,
    '24h TTL',
  );

  // The room id is derived from the secret exactly like native.
  assertEqual(deriveRoomId(result.roomSecret), result.roomId, 'room id derivation');

  // Recompute both auth headers from first principles — they must verify.
  const bodyBytes = new TextEncoder().encode(create.body);
  const keys = deriveRoomKeys(result.roomSecret);
  assertEqual(
    create.headers['Attn-Admission'],
    buildAdmissionHeader(keys.admissionKey, 'POST', `/v2/rooms/${result.roomId}`, bodyBytes),
    'admission HMAC binds the body',
  );
  const ownerKey = base64UrlDecode(body.ownerSigningKey);
  assert(ownerKey.length === 32, 'owner key is 32 bytes');
  assertEqual(
    create.headers['Attn-Owner-Signature'],
    buildOwnerSignatureHeader(
      result.identity.signingSecret,
      'POST',
      `/v2/rooms/${result.roomId}`,
      bodyBytes,
    ),
    'owner signature is over the canonical request',
  );
  assertEqual(create.headers['Attn-PoW'], 'pow-token-stub', 'pow attached');
  assertEqual(
    base64UrlDecode(body.admissionKey).length,
    32,
    'admission key present and 32 bytes',
  );

  // Registration is an owner-kind device with a valid self-signature.
  const register = requests[1]!;
  const registerBody = JSON.parse(register.body);
  assertEqual(registerBody.kind, 'owner', 'owner registration');
  assertEqual(registerBody.client, 'attn-browser', 'browser client');
  assert(register.headers['Attn-Admission']?.startsWith('v2.'), 'register admission');
  assertEqual(result.created, true, '201 => created');
});

defineCase('v3 create uses split read/write admission and room-bound grants', async () => {
  const { fetchImpl, requests } = stubRelay({});
  const result = await createOwnedRoomV3({ relayUrl: RELAY, fetchImpl, mintPow });
  assertEqual(requests.length, 2, 'v3 create then register');
  const create = requests[0]!;
  const body = JSON.parse(create.body);
  const path = `/v3/rooms/${result.roomId}`;
  assertEqual(create.url, `${RELAY}${path}`, 'v3 create route');
  assertEqual(body.v, 3, 'v3 body');
  assertEqual(deriveRoomIdV3(result.roomSecret), result.roomId, 'v3 room id');
  const keys = deriveRoomKeyTreeV3(result.roomSecret);
  const bodyBytes = new TextEncoder().encode(create.body);
  assertEqual(
    create.headers['Attn-Admission'],
    buildAdmissionHeaderV3(keys.writeAdmissionKey, 'write', 'POST', path, bodyBytes),
    'v3 write admission binds create',
  );
  assert(body.readAdmissionKey !== body.writeAdmissionKey, 'split admission leaves differ');
  assertEqual(base64UrlDecode(result.commentGrantSignature).length, 64, 'comment grant bytes');
  assertEqual(base64UrlDecode(result.suggestGrantSignature).length, 64, 'suggest grant bytes');
  const register = requests[1]!;
  assert(register.url.includes('/v3/rooms/'), 'v3 device route');
  assert(register.headers['Attn-Admission']?.startsWith('v3.write.'), 'v3 register write admission');
});

defineCase('v3 delete signs and write-authenticates the exact route', async () => {
  const identity = generateBrowserIdentity();
  const roomSecret = new Uint8Array(32).fill(31);
  const roomId = deriveRoomIdV3(roomSecret);
  const keys = deriveRoomKeyTreeV3(roomSecret);
  const { fetchImpl, requests } = stubRelay({ deleteStatus: 204 });
  const stopped = await deleteOwnedRoomV3({
    relayUrl: RELAY,
    roomId,
    identity,
    writeAdmissionKey: keys.writeAdmissionKey,
    fetchImpl,
    mintPow,
  });
  assertEqual(stopped, true, 'v3 delete accepted');
  const request = requests[0]!;
  const path = `/v3/rooms/${roomId}`;
  assertEqual(request.url, `${RELAY}${path}`, 'v3 delete route');
  assertEqual(
    request.headers['Attn-Admission'],
    buildAdmissionHeaderV3(keys.writeAdmissionKey, 'write', 'DELETE', path, new Uint8Array(0)),
    'v3 delete admission',
  );
});

defineCase('explicit long session carries the relay 7-day opt-in', async () => {
  const now = 1_700_000_000_000;
  const { fetchImpl, requests } = stubRelay({});
  const policy = defaultOwnerPolicy(now);
  policy.expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  await createOwnedRoom({
    relayUrl: RELAY,
    fetchImpl,
    mintPow,
    now: () => now,
    policy,
    longSession: true,
  });
  const body = JSON.parse(requests[0]!.body);
  assertEqual(body.policy.longSession, true, 'long-session wire flag');
  assertEqual(body.policy.expiresAt, policy.expiresAt, '7-day expiry request');
});

defineCase('rejoin (200) is idempotent and does not roll back', async () => {
  const { fetchImpl, requests } = stubRelay({ createStatus: 200 });
  const result = await createOwnedRoom({ relayUrl: RELAY, fetchImpl, mintPow });
  assertEqual(result.created, false, '200 => rejoin');
  assertEqual(requests.length, 2, 'no delete issued');
});

defineCase('registration failure after first-create rolls the room back', async () => {
  const { fetchImpl, requests } = stubRelay({ registerStatus: 403 });
  let failure: OwnerBootstrapError | null = null;
  try {
    await createOwnedRoom({ relayUrl: RELAY, fetchImpl, mintPow });
  } catch (error) {
    failure = error instanceof OwnerBootstrapError ? error : null;
  }
  assert(failure, 'typed bootstrap error');
  assertEqual(failure.stage, 'register', 'failure stage');
  const del = requests.find((request) => request.method === 'DELETE');
  assert(del, 'rollback DELETE issued');
  assert(del.headers['Attn-Owner-Signature']?.length > 0, 'rollback is owner-signed');
});

defineCase('registration failure on rejoin does NOT delete the existing room', async () => {
  const { fetchImpl, requests } = stubRelay({ createStatus: 200, registerStatus: 500 });
  let threw = false;
  try {
    await createOwnedRoom({ relayUrl: RELAY, fetchImpl, mintPow });
  } catch {
    threw = true;
  }
  assert(threw, 'registration failure surfaces');
  assert(!requests.some((request) => request.method === 'DELETE'), 'no rollback on rejoin');
});

defineCase('create failure surfaces relay status without registration', async () => {
  const { fetchImpl, requests } = stubRelay({ createStatus: 429 });
  let failure: OwnerBootstrapError | null = null;
  try {
    await createOwnedRoom({ relayUrl: RELAY, fetchImpl, mintPow });
  } catch (error) {
    failure = error instanceof OwnerBootstrapError ? error : null;
  }
  assert(failure, 'typed error');
  assertEqual(failure.stage, 'create', 'create stage');
  assertEqual(failure.status, 429, 'status surfaced');
  assertEqual(requests.length, 1, 'no registration attempted');
});

defineCase('deleteOwnedRoom signs the canonical DELETE verifiably', async () => {
  const { fetchImpl, requests } = stubRelay({});
  const identity = generateBrowserIdentity();
  const admissionKey = crypto.getRandomValues(new Uint8Array(32));
  const ok = await deleteOwnedRoom({
    relayUrl: RELAY,
    roomId: 'room-x',
    identity,
    admissionKey,
    fetchImpl,
    mintPow,
  });
  assert(ok, 'delete acknowledged');
  const del = requests[0]!;
  assert(del.headers['Attn-Admission']?.startsWith('v2.'), 'delete carries admission');
  assertEqual(del.headers['Attn-PoW'], 'pow-token-stub', 'delete carries pow');
  const signature = base64UrlDecode(del.headers['Attn-Owner-Signature']!);
  assertEqual(signature.length, 64, 'ed25519 signature length');
  // Reconstruct the relay's canonical request bytes (admission.ts):
  // METHOD \n path \n canonicalQuery \n sha256(body).
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const encoder = new TextEncoder();
  const head = encoder.encode('DELETE\n/v2/rooms/room-x\n\n');
  const bodyHash = sha256(new Uint8Array(0));
  const canonical = new Uint8Array(head.length + bodyHash.length);
  canonical.set(head, 0);
  canonical.set(bodyHash, head.length);
  assert(
    ed25519.verify(signature, canonical, identity.signingPublic),
    'signature verifies against the owner public key over canonical bytes',
  );
});

defineCase('deleteOwnedRoom treats already absent or expired rooms as stopped', async () => {
  for (const status of [404, 410]) {
    const { fetchImpl } = stubRelay({ deleteStatus: status });
    const identity = generateBrowserIdentity();
    const deleted = await deleteOwnedRoom({
      relayUrl: RELAY,
      roomId: deriveRoomId(new Uint8Array(32).fill(status)),
      identity,
      admissionKey: new Uint8Array(32).fill(3),
      fetchImpl,
      mintPow,
    });
    assertEqual(deleted, true, `${status} is idempotently stopped`);
  }
});

defineCase('default policy mirrors the native defaults', () => {
  const policy = defaultOwnerPolicy(1_000);
  assertEqual(policy.maxSnapshotBytes, 5 * 1024 * 1024, 'snapshot cap');
  assertEqual(policy.maxEventBytes, 256 * 1024, 'event cap');
  assertEqual(policy.maxEvents, 500, 'event count');
  assertEqual(policy.allowRemoteAgents, true, 'agents allowed');
  assertEqual(policy.expiresAt, 1_000 + 86_400_000, '24h');
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`browser-owner-bootstrap: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
