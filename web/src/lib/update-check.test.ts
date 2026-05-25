// Manual harness for the update-available check.
//
//   cd web && npx tsx src/lib/update-check.test.ts

import { checkForUpdate, isNewerVersion, upgradeHint } from './update-check';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    failed += 1;
    console.error(`FAIL ${msg}`);
  }
}

// --- isNewerVersion ---------------------------------------------------------
assert(isNewerVersion('0.6.8', '0.6.7'), 'patch bump is newer');
assert(isNewerVersion('0.7.0', '0.6.9'), 'minor bump beats higher patch');
assert(isNewerVersion('1.0.0', '0.9.9'), 'major bump is newer');
assert(isNewerVersion('v0.6.8', '0.6.7'), 'leading v is tolerated');
assert(!isNewerVersion('0.6.7', '0.6.7'), 'equal is not newer');
assert(!isNewerVersion('0.6.6', '0.6.7'), 'older is not newer');

// --- upgradeHint (Homebrew is macOS-only) -----------------------------------
assert(upgradeHint(true).includes('brew upgrade attn'), 'macOS hint mentions brew');
assert(upgradeHint(true).includes('npm i -g attnmd'), 'macOS hint also offers npm');
assert(!upgradeHint(false).includes('brew'), 'non-macOS hint never mentions brew');
assert(upgradeHint(false).includes('npm i -g attnmd'), 'non-macOS hint uses npm');

// --- checkForUpdate (injected fetch) ----------------------------------------
const mockFetch = (body: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

async function main(): Promise<void> {
  const behind = await checkForUpdate('0.6.7', mockFetch({ version: '0.6.8' }));
  assert(behind?.latest === '0.6.8' && behind?.current === '0.6.7', 'reports update when behind');

  assert((await checkForUpdate('0.6.8', mockFetch({ version: '0.6.8' }))) === null, 'no update when current');
  assert((await checkForUpdate('0.7.0', mockFetch({ version: '0.6.8' }))) === null, 'no update when ahead of npm');
  assert((await checkForUpdate('0.6.7', mockFetch({ version: '0.6.8' }, false))) === null, 'non-ok response → null');
  assert((await checkForUpdate('0.6.7', mockFetch({}))) === null, 'missing version field → null');
  assert((await checkForUpdate(undefined, mockFetch({ version: '9.9.9' }))) === null, 'no current version → null');

  const errFetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert((await checkForUpdate('0.6.7', errFetch)) === null, 'fetch error → null (silent)');

  // Force exit so a pending AbortSignal.timeout timer can't delay the runner.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
