import { base64UrlDecode, base64UrlEncode } from "./admission";
import type { Env } from "./env";

export const PUSH_SUBSCRIPTION_PREFIX = "push:subscription:";
export const PUSH_LAST_SENT_PREFIX = "push:last-sent:";
export const MAX_PUSH_SUBSCRIPTIONS = 32;
export const PUSH_DEBOUNCE_MS = 30_000;

const MAX_ENDPOINT_CHARS = 2_048;
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
const ALLOWED_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;

export interface StoredPushSubscription {
  v: 3;
  deviceId: string;
  /** Present only for tiered durable-share subscriptions. */
  bundleId?: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  updatedAt: number;
  /** Resource TTL, additionally capped by expirationTime when supplied. */
  expiresAt: number;
}

export interface PushSubscriptionInput {
  v: 3;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export type PushSendResult = "sent" | "gone" | "retained" | "disabled";

export type PublicPushSubscription = Omit<StoredPushSubscription, "endpoint" | "keys">;

export function pushSubscriptionKey(deviceId: string): string {
  return `${PUSH_SUBSCRIPTION_PREFIX}${deviceId}`;
}

export function pushLastSentKey(deviceId: string): string {
  return `${PUSH_LAST_SENT_PREFIX}${deviceId}`;
}

export function parsePushSubscriptionInput(value: unknown, now = Date.now()): PushSubscriptionInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!hasExactKeys(candidate, ["endpoint", "expirationTime", "keys", "v"]) || candidate.v !== 3) return undefined;
  if (typeof candidate.endpoint !== "string" || !isAllowedPushEndpoint(candidate.endpoint)) return undefined;
  if (candidate.expirationTime !== null && (
    typeof candidate.expirationTime !== "number"
    || !Number.isSafeInteger(candidate.expirationTime)
    || candidate.expirationTime <= now
  )) return undefined;
  if (typeof candidate.keys !== "object" || candidate.keys === null || Array.isArray(candidate.keys)) return undefined;
  const keys = candidate.keys as Record<string, unknown>;
  if (!hasExactKeys(keys, ["auth", "p256dh"]) || !isCanonicalBytes(keys.auth, 16) || !isCanonicalP256dh(keys.p256dh)) {
    return undefined;
  }
  return {
    v: 3,
    endpoint: candidate.endpoint,
    expirationTime: candidate.expirationTime,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

export async function pushPublicConfig(env: Env): Promise<{ enabled: boolean; vapidPublicKey?: string }> {
  if (!isCanonicalP256dh(env.VAPID_PUBLIC_KEY) || !isValidVapidSubject(env.VAPID_SUBJECT)) return { enabled: false };
  const privateJwk = parseMatchingVapidJwk(env.VAPID_PRIVATE_JWK, env.VAPID_PUBLIC_KEY);
  if (privateJwk === undefined) return { enabled: false };
  if (!await provesVapidKeypair(privateJwk, env.VAPID_PUBLIC_KEY)) return { enabled: false };
  return { enabled: true, vapidPublicKey: env.VAPID_PUBLIC_KEY };
}

export function publicPushSubscription(value: StoredPushSubscription): PublicPushSubscription {
  const { endpoint: _endpoint, keys: _keys, ...safe } = value;
  return safe;
}

/**
 * Send an RFC 8292 VAPID-authenticated request with no body. No room/share
 * identifier, event kind, author, ciphertext, or locally-derived text crosses
 * the push service boundary; receipt only tells the service that an endpoint
 * was pinged.
 */
export async function sendPayloadlessPush(env: Env, endpoint: string, now = Date.now()): Promise<PushSendResult> {
  if (!isAllowedPushEndpoint(endpoint)) return "retained";
  const config = await pushPublicConfig(env);
  if (!config.enabled || config.vapidPublicKey === undefined || env.VAPID_PRIVATE_JWK === undefined) return "disabled";

  const privateJwk = parseMatchingVapidJwk(env.VAPID_PRIVATE_JWK, config.vapidPublicKey);
  if (privateJwk === undefined) return "disabled";
  const endpointUrl = new URL(endpoint);
  const token = await signVapidToken({
    audience: endpointUrl.origin,
    subject: env.VAPID_SUBJECT!,
    privateJwk,
    now,
  }).catch(() => undefined);
  if (token === undefined) return "disabled";

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `vapid t=${token}, k=${config.vapidPublicKey}`,
        "Content-Length": "0",
        TTL: "300",
        Urgency: "normal",
      },
    });
  } catch {
    return "retained";
  }
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "sent" : "retained";
}

export function isDeviceLive(sockets: readonly WebSocket[], deviceId: string): boolean {
  return sockets.some(socket => {
    const attachment = socket.deserializeAttachment() as Record<string, unknown> | null;
    return attachment?.kind === "device" && attachment.deviceId === deviceId;
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isCanonicalBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string") return false;
  try {
    const decoded = base64UrlDecode(value);
    return decoded.length === bytes && base64UrlEncode(decoded) === value;
  } catch {
    return false;
  }
}

function isCanonicalP256dh(value: unknown): value is string {
  if (!isCanonicalBytes(value, 65)) return false;
  return base64UrlDecode(value)[0] === 0x04;
}

function isAllowedPushEndpoint(value: string): boolean {
  if (value.length < 1 || value.length > MAX_ENDPOINT_CHARS) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.hash === ""
      && ALLOWED_PUSH_ENDPOINT_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isValidVapidSubject(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
  if (value.startsWith("mailto:")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.slice("mailto:".length));
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function parseMatchingVapidJwk(raw: string | undefined, publicKey: string): JsonWebKey | undefined {
  if (raw === undefined) return undefined;
  try {
    const privateJwk = JSON.parse(raw) as JsonWebKey;
    if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || typeof privateJwk.d !== "string"
      || typeof privateJwk.x !== "string" || typeof privateJwk.y !== "string") return undefined;
    if (!isCanonicalBytes(privateJwk.d, 32)) return undefined;
    const x = base64UrlDecode(privateJwk.x);
    const y = base64UrlDecode(privateJwk.y);
    if (x.length !== 32 || y.length !== 32) return undefined;
    const jwkPublic = new Uint8Array(65);
    jwkPublic[0] = 0x04;
    jwkPublic.set(x, 1);
    jwkPublic.set(y, 33);
    return base64UrlEncode(jwkPublic) === publicKey ? privateJwk : undefined;
  } catch {
    return undefined;
  }
}

async function provesVapidKeypair(privateJwk: JsonWebKey, publicKey: string): Promise<boolean> {
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    const publicCryptoKey = await crypto.subtle.importKey(
      "raw", base64UrlDecode(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const challenge = new TextEncoder().encode("attn VAPID config proof v1");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicCryptoKey, signature, challenge);
  } catch {
    return false;
  }
}

async function signVapidToken(options: {
  audience: string;
  subject: string;
  privateJwk: JsonWebKey;
  now: number;
}): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: options.audience,
    exp: Math.floor(options.now / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
    sub: options.subject,
  })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    options.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  ));
  if (signature.length !== 64) throw new Error("unexpected ES256 signature length");
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
