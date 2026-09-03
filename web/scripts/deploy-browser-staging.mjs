#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContentSecurityPolicy } from '../src/lib/hosted/csp.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayOrigin = 'https://relay-staging.attn.sh';
const webOrigin = 'https://staging.attn.sh';
const forwardedWranglerArgs = process.argv.slice(2);
validateWranglerArgs(forwardedWranglerArgs);
const dryRun = forwardedWranglerArgs.includes('--dry-run');
const buildEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('CLOUDFLARE_')),
);

await run(npmExecutable(), ['run', 'build:browser'], {
  ...buildEnv,
  VITE_ATTN_RELAY_URL: relayOrigin,
});

const entryPath = await verifyBuild(relayOrigin);
await run(wranglerExecutable(), [
  'deploy',
  '--config',
  'wrangler.jsonc',
  ...forwardedWranglerArgs,
], process.env);

if (!dryRun) await verifyLiveDeployment(webOrigin, relayOrigin, entryPath);

function validateWranglerArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run' || arg.startsWith('--outdir=')) continue;
    if (arg === '--outdir' && typeof args[index + 1] === 'string') {
      index += 1;
      continue;
    }
    throw new Error(`unsupported staging deploy argument: ${arg}`);
  }
}

async function verifyBuild(expectedRelayOrigin) {
  // Landing must exist and must not reference the review/editor graph; the
  // full boundary walk lives in check-route-bundles.mjs, run before deploy.
  await run(process.execPath, [path.join(webRoot, 'scripts', 'check-route-bundles.mjs')], process.env);

  const reviewIndexPath = path.join(webRoot, 'dist-browser', 'review', 'index.html');
  const reviewHtml = await readFile(reviewIndexPath, 'utf8');
  const entryMatch = reviewHtml.match(/<script[^>]+src="(\/assets\/review-[A-Za-z0-9_-]+\.js)"/u);
  if (!entryMatch) throw new Error('hosted build is missing its hashed review entry script');
  const entryPath = entryMatch[1];
  const entrySource = await readFile(path.join(webRoot, 'dist-browser', entryPath), 'utf8');
  if (!entrySource.includes(expectedRelayOrigin)) {
    throw new Error(`hosted entry does not embed the expected relay origin: ${expectedRelayOrigin}`);
  }
  // The worker builds its CSP from the RELAY_ORIGIN var; make sure the
  // staging config pins the staging relay before shipping.
  const wranglerConfig = await readFile(path.join(webRoot, 'wrangler.jsonc'), 'utf8');
  if (!wranglerConfig.includes(`"RELAY_ORIGIN": "${expectedRelayOrigin}"`)) {
    throw new Error('wrangler.jsonc does not pin RELAY_ORIGIN to the staging relay origin');
  }
  return entryPath;
}

async function verifyLiveDeployment(expectedWebOrigin, expectedRelayOrigin, expectedEntryPath) {
  // Derive the expected policy from the same function the worker serves it
  // from, rather than restating the directives here. A hardcoded copy has now
  // rejected a healthy deploy twice — once when the script-src hash landed,
  // once when img-src gained `https:` for remote document images — and in both
  // cases the deploy itself was fine and only this check was stale.
  const requiredCspDirectives = new Set(
    buildContentSecurityPolicy(expectedRelayOrigin)
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
  const deadline = Date.now() + 60_000;
  let lastFailure = 'deployment did not become readable';
  while (Date.now() < deadline) {
    const probe = `${expectedWebOrigin}/review/deploy-probe-${Date.now()}?v=${Date.now()}`;
    try {
      const response = await fetch(probe, { cache: 'no-store', redirect: 'error' });
      const html = await response.text();
      const csp = response.headers.get('content-security-policy') ?? '';
      const cacheControl = response.headers.get('cache-control') ?? '';
      if (!response.ok) throw new Error(`HTML probe returned ${response.status}`);
      if (!html.includes(expectedEntryPath)) throw new Error('HTML probe still references an older entry');
      const liveCspDirectives = new Set(csp.split(';').map((directive) => directive.trim()).filter(Boolean));
      if (
        liveCspDirectives.size !== requiredCspDirectives.size ||
        [...requiredCspDirectives].some((directive) => !liveCspDirectives.has(directive))
      ) {
        throw new Error('live CSP does not match the pinned staging policy');
      }
      if (!cacheControl.includes('no-store')) throw new Error('live HTML is not marked no-store');

      const entry = await fetch(`${expectedWebOrigin}${expectedEntryPath}`, {
        cache: 'no-store',
        redirect: 'error',
      });
      const entrySource = await entry.text();
      if (!entry.ok) throw new Error(`entry probe returned ${entry.status}`);
      if (!entrySource.includes(expectedRelayOrigin)) {
        throw new Error('live entry omits the staging relay origin');
      }
      process.stdout.write(
        `Verified ${expectedWebOrigin} serves ${expectedEntryPath} with ${expectedRelayOrigin}\n`,
      );
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(`staging propagation verification timed out: ${lastFailure}`);
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function wranglerExecutable() {
  return path.join(webRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: webRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}
