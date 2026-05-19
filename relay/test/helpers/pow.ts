/**
 * Shared test helper to mint PoW tokens that match the relay's `verifyPow`
 * expectations. Copied from `test/unit/pow.test.ts` so integration tests
 * (devices, envelopes, etc.) don't have to re-import that file.
 *
 * Must mirror the Rust 1.7 token format byte-for-byte so corpus replay tests
 * keep passing on both sides.
 */

import { leadingZeroBits, requestPathHash } from "../../src/pow";

/** Counter-incrementing SHA-256 search. Stops early when difficulty=12 is hit. */
export async function mintPowForTests(opts: {
  roomId: string;
  deviceId: string;
  method: string;
  path: string;
  difficulty: number;
  expiresAt: number;
  rand: string;
}): Promise<string> {
  const { roomId, deviceId, method, path, difficulty, expiresAt, rand } = opts;
  const resource = `${roomId}:${deviceId}:${await requestPathHash(method, path)}`;
  const encoder = new TextEncoder();
  let counter = 0;
  // Hard ceiling so a runaway test fails instead of hanging the suite.
  const max = 10_000_000;
  while (counter < max) {
    const token = `attn-pow:v2:${difficulty}:${expiresAt}:${resource}:${rand}:${counter}`;
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(token)),
    );
    if (leadingZeroBits(hashBytes) >= difficulty) return token;
    counter++;
  }
  throw new Error(`mintPowForTests exceeded ${max} attempts`);
}

/** 16-byte base64url-no-pad. Used by multiple integration tests. */
export const FIXED_POW_RAND = "ELoREhMUFRYXGBkaGxwdHg";
