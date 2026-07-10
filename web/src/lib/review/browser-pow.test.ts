import fs from 'node:fs';
import path from 'node:path';
import {
  leadingZeroBits,
  mineBrowserPow,
  powResource,
  requestPathHash,
} from './browser-pow';

interface PowCorpus {
  vectors: Array<{
    name: string;
    inputs: {
      method: string;
      pathSubstituted: string;
      roomId: string;
      deviceId: string;
      rand: string;
      expiresAt: number;
      difficulty: number;
    };
    expected: {
      requestPathHash: string;
      resource: string;
      counter: string;
      tokenHashHex: string;
      token: string;
    };
  }>;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const corpusPath = path.resolve(process.cwd(), '../planning/collab/test-vectors/pow.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as PowCorpus;

for (const vector of corpus.vectors) {
  const { inputs, expected } = vector;
  assertEq(
    requestPathHash(inputs.method, inputs.pathSubstituted),
    expected.requestPathHash,
    `${vector.name}: request path hash`,
  );
  assertEq(
    powResource(inputs.roomId, inputs.deviceId, inputs.method, inputs.pathSubstituted),
    expected.resource,
    `${vector.name}: resource`,
  );
  const mined = mineBrowserPow({
    roomId: inputs.roomId,
    deviceId: inputs.deviceId,
    method: inputs.method,
    path: inputs.pathSubstituted,
    difficulty: inputs.difficulty,
    expiresAt: inputs.expiresAt,
    rand: inputs.rand,
  });
  assertEq(mined.counter.toString(), expected.counter, `${vector.name}: smallest counter`);
  assertEq(mined.token, expected.token, `${vector.name}: token`);
  assertEq(hex(mined.hash), expected.tokenHashHex, `${vector.name}: token hash`);
  if (leadingZeroBits(mined.hash) < inputs.difficulty) {
    throw new Error(`${vector.name}: mined hash does not meet difficulty`);
  }
}

console.log(`browser-pow: ${corpus.vectors.length} corpus vectors passed`);
