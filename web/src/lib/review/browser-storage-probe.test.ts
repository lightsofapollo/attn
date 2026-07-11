import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  probeStorageCapabilities,
  quotaPressure,
  toPersistenceMode,
} from './browser-storage-probe';
import type { BrowserStorageNavigator } from './browser-storage';

Object.defineProperty(globalThis, 'IDBKeyRange', {
  configurable: true,
  value: IDBKeyRange,
});

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

// In-memory OPFS root good enough for the probe protocol.
function fakeOpfsRoot(): { root: unknown; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const dir = (prefix: string): unknown => ({
    getDirectoryHandle: async (name: string) => dir(`${prefix}${name}/`),
    getFileHandle: async (name: string) => ({
      getFile: async () => ({
        arrayBuffer: async () => (files.get(`${prefix}${name}`) ?? new Uint8Array()).buffer,
      }),
      createWritable: async () => ({
        write: async (data: Uint8Array) => {
          files.set(`${prefix}${name}`, new Uint8Array(data));
        },
        close: async () => undefined,
      }),
    }),
    removeEntry: async (name: string) => {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${prefix}${name}`)) files.delete(key);
      }
    },
  });
  return { root: dir(''), files };
}

interface FakeNavOptions {
  persisted?: boolean | null;
  persistResult?: boolean;
  estimate?: { usage?: number; quota?: number } | null;
  opfs?: 'ok' | 'missing' | 'refused';
}

function fakeNavigator(options: FakeNavOptions): BrowserStorageNavigator {
  const { root } = fakeOpfsRoot();
  return {
    storage: {
      ...(options.persisted === null
        ? {}
        : { persisted: async () => options.persisted ?? false }),
      ...(options.persistResult === undefined
        ? {}
        : { persist: async () => options.persistResult! }),
      ...(options.estimate === null || options.estimate === undefined
        ? {}
        : { estimate: async () => options.estimate! }),
      ...(options.opfs === 'missing'
        ? {}
        : {
            getDirectory: async () => {
              if (options.opfs === 'refused') {
                throw new DOMException('access denied for this session', 'SecurityError');
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return root as any;
            },
          }),
    },
  } as BrowserStorageNavigator;
}

let counter = 0;
function probeName(): string {
  counter += 1;
  return `attn-probe-test-${counter}`;
}

defineCase('healthy persistent profile reports persistent with all probes ok', async () => {
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto,
    navigator: fakeNavigator({ persisted: true, estimate: { usage: 10, quota: 1000 }, opfs: 'ok' }),
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'persistent', 'mode');
  assert(result.indexedDb.ok, 'idb ok');
  assert(result.cryptoKeyClone.ok, 'key clone ok');
  assert(result.opfs.ok, 'opfs ok');
  assertEqual(result.persisted, true, 'persisted');
  assertEqual(result.estimate?.quota, 1000, 'estimate quota');
  assertEqual(toPersistenceMode(result), 'persistent', 'shell mapping');
});

defineCase('unpersisted profile is best_effort; persist request is honored', async () => {
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto,
    navigator: fakeNavigator({ persisted: false, persistResult: true, opfs: 'ok' }),
    databaseName: probeName(),
    requestPersist: true,
  });
  assertEqual(result.mode, 'best_effort', 'mode without persisted=true');
  assertEqual(result.persistRequested, true, 'persist request result surfaced');
  assertEqual(toPersistenceMode(result), 'best-effort', 'shell mapping');
});

defineCase('OPFS refusal with a security error reports volatile (private session)', async () => {
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto,
    navigator: fakeNavigator({ persisted: false, opfs: 'refused' }),
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'volatile', 'mode');
  assert(result.opfs.apiPresent, 'API present');
  assertEqual(result.opfs.cause?.name, 'SecurityError', 'precise cause');
  assertEqual(toPersistenceMode(result), 'session-only', 'shell mapping');
});

defineCase('missing OPFS API is merely best_effort, not volatile', async () => {
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto,
    navigator: fakeNavigator({ persisted: false, opfs: 'missing' }),
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'best_effort', 'mode');
  assert(!result.opfs.apiPresent, 'API absent');
  assert(!result.opfs.ok, 'opfs not ok');
});

defineCase('blocked IndexedDB reports unsupported with a precise cause', async () => {
  const blockedFactory = {
    open() {
      throw new DOMException('IDB disabled by policy', 'SecurityError');
    },
  } as unknown as IDBFactory;
  const result = await probeStorageCapabilities({
    indexedDB: blockedFactory,
    crypto,
    navigator: fakeNavigator({ persisted: false, opfs: 'ok' }),
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'unsupported', 'mode');
  assertEqual(result.indexedDb.cause?.name, 'SecurityError', 'cause name');
  assertEqual(result.cryptoKeyClone.cause?.name, 'Skipped', 'key probe skipped');
  assertEqual(toPersistenceMode(result), 'unavailable', 'shell mapping');
});

defineCase('extractable-key crypto reports unsupported via the clone probe', async () => {
  const trickCrypto = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
    subtle: {
      importKey: async (...args: Parameters<SubtleCrypto['importKey']>) => {
        // A broken WebCrypto that ignores the extractable=false request.
        const [format, material, algorithm, , usages] = args;
        return crypto.subtle.importKey(format as 'raw', material as Uint8Array, algorithm, true, usages);
      },
      deriveBits: crypto.subtle.deriveBits.bind(crypto.subtle),
    },
  } as unknown as Crypto;
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto: trickCrypto,
    navigator: fakeNavigator({ persisted: false, opfs: 'ok' }),
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'unsupported', 'mode');
  assert(!result.cryptoKeyClone.ok, 'clone probe failed');
});

defineCase('quota pressure math and shell mapping', () => {
  assert(!quotaPressure(null), 'null estimate is not pressure');
  assert(!quotaPressure({ usage: 10, quota: 1000 }), 'low usage');
  assert(quotaPressure({ usage: 96, quota: 100 }), 'high usage');
  assert(!quotaPressure({ usage: 5 }), 'missing quota');
  assertEqual(
    toPersistenceMode({ mode: 'persistent', estimate: { usage: 99, quota: 100 } }),
    'quota-pressure',
    'pressure overrides persistent for the shells',
  );
});

defineCase('null navigator still probes IDB and key cloning', async () => {
  const result = await probeStorageCapabilities({
    indexedDB: new IDBFactory(),
    crypto,
    navigator: null,
    databaseName: probeName(),
  });
  assertEqual(result.mode, 'best_effort', 'mode');
  assertEqual(result.persisted, null, 'persisted unknown');
  assertEqual(result.estimate, null, 'no estimate');
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
  console.log(`browser-storage-probe: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
