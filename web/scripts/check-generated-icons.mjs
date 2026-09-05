#!/usr/bin/env node
// Integrity check for the committed icon output (attn-6q7b).
//
// Generation used to run on every build, so the output could not drift from
// the generator. Now that the output is committed and generation is an
// explicit refresh, something has to notice when the two disagree — a pack
// module importing an SVG that was never committed would otherwise fail at
// `vite build` with an unresolved-import error far from its cause.
//
// This deliberately does NOT re-run the generator: it must pass with nothing
// fetched, which is the whole point of committing the output. It checks the
// committed tree is internally consistent, not that it matches upstream.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(webRoot, 'src/lib/icons/vscode-generated');
const packDir = path.join(webRoot, 'src/lib/vscode-icon-packs');
const manifestPath = path.join(webRoot, 'src/lib/vscode-icon-map.generated.ts');

const problems = [];

function requireDir(dir, label) {
  if (!fs.existsSync(dir)) {
    problems.push(`${label} is missing (${path.relative(webRoot, dir)}). Run: npm run refresh:icons`);
    return false;
  }
  return true;
}

if (
  requireDir(iconsDir, 'generated icon directory')
  && requireDir(packDir, 'generated pack modules')
) {
  const present = new Set(fs.readdirSync(iconsDir).filter((name) => name.endsWith('.svg')));
  const packModules = fs.readdirSync(packDir).filter((name) => name.endsWith('.generated.ts'));

  if (packModules.length === 0) {
    problems.push('no generated pack modules found. Run: npm run refresh:icons');
  }

  const referenced = new Set();
  for (const moduleName of packModules) {
    const source = fs.readFileSync(path.join(packDir, moduleName), 'utf8');
    for (const match of source.matchAll(/from '\$lib\/icons\/vscode-generated\/([^']+)'/gu)) {
      referenced.add(match[1]);
      if (!present.has(match[1])) {
        problems.push(`${moduleName} imports ${match[1]}, which is not committed`);
      }
    }
  }

  // Orphans are not a build failure, but they mean the committed tree was not
  // produced by one generator run — worth failing while the cause is fresh.
  for (const name of present) {
    if (!referenced.has(name)) {
      problems.push(`${name} is committed but no pack module references it`);
    }
  }

  if (!fs.existsSync(manifestPath)) {
    problems.push('vscode-icon-map.generated.ts is missing. Run: npm run refresh:icons');
  } else {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    for (const moduleName of packModules) {
      const pack = moduleName.replace(/\.generated\.ts$/u, '');
      if (!manifest.includes(`vscode-icon-packs/${pack}.generated`)) {
        problems.push(`the manifest does not load the "${pack}" pack module`);
      }
    }
  }

  if (problems.length === 0) {
    process.stdout.write(
      `generated icons OK: ${present.size} svgs, ${packModules.length} pack modules\n`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems.slice(0, 20)) process.stderr.write(`  ${problem}\n`);
  if (problems.length > 20) process.stderr.write(`  ...and ${problems.length - 20} more\n`);
  process.stderr.write(`generated icon check failed (${problems.length} problems)\n`);
  process.exitCode = 1;
}
