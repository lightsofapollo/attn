#!/usr/bin/env node

const {
  accessSync,
  chmodSync,
  constants: fsConstants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const { createInterface } = require("node:readline/promises");
const https = require("node:https");

const packageDir = join(__dirname, "..");
const runtimeDir = join(packageDir, "bin-runtime");
const runtimeBinaryPath = join(runtimeDir, "attn");
const packageJsonPath = join(packageDir, "package.json");
const userHome = homedir();

const managedRoot = join(userHome, ".local", "share", "attn");
const managedAppsRoot = join(managedRoot, "apps");
const managedCurrentAppLink = join(managedRoot, "current-app");

const installLinkDir = join(userHome, ".local", "bin");
const installLinkPath = join(installLinkDir, "attn");
const installLauncherPath = join(managedRoot, "bin", "attn-launcher.sh");

const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const isNpxInvocation =
  process.env.npm_execpath?.includes("npx") || process.argv[1]?.includes("attnmd");

const HEADLESS_FLAGS = new Set([
  "--status",
  "--json",
  "--check",
  "--info",
  "--eval",
  "--click",
  "--wait-for",
  "--query",
  "--fill",
]);

main().catch((error) => {
  console.error(`attn: ${error.message}`);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = packageJson.version;
  const headless = isHeadlessInvocation(args);

  // Prefer a natively-installed `attn` only when it matches this npm
  // package. `npx attnmd@<version>` must not silently hand off to an older
  // Homebrew/cargo/alias binary whose review protocol may be incompatible.
  const nativeBinary = findNativeBinary(version);
  if (nativeBinary) {
    if (process.env.ATTN_DEBUG_LAUNCHER) {
      console.error(`attn: using native binary ${nativeBinary}`);
    }
    run(nativeBinary, args);
    return;
  }

  let appPath = null;
  if (process.platform === "darwin") {
    try {
      appPath = await resolveAppPath(version);
    } catch (error) {
      console.error(`attn: app install unavailable (${error.message}); falling back to binary.`);
    }
  }

  if (!appPath) {
    if (!isExpectedBinaryVersion(runtimeBinaryPath, version)) {
      safeRemove(runtimeBinaryPath);
      await ensureRuntimeBinary(version);
    }
    if (!existsSync(runtimeBinaryPath)) {
      throw new Error("runtime binary is missing after fallback download attempt.");
    }
    if (isNpxInvocation) {
      await maybePromptInstallAlias();
    }
    run(runtimeBinaryPath, args);
    return;
  }

  if (isNpxInvocation) {
    await maybePromptInstallAlias();
  }

  if (headless) {
    const binaryPath = join(appPath, "Contents", "MacOS", "attn");
    if (!existsSync(binaryPath)) {
      throw new Error(`managed app binary is missing at ${binaryPath}`);
    }
    run(binaryPath, args);
    return;
  }

  run("/usr/bin/open", [appPath, "--args", ...resolvePathArgs(args)]);
}

async function resolveAppPath(version) {
  const globalApp = findGlobalAppInstall(version);
  if (globalApp) {
    return globalApp;
  }

  const managedVersionApp = join(managedAppsRoot, version, "attn.app");
  if (
    existsSync(managedVersionApp) &&
    isExpectedBinaryVersion(join(managedVersionApp, "Contents", "MacOS", "attn"), version)
  ) {
    ensureCurrentAppLink(managedVersionApp);
    return managedVersionApp;
  }

  await installManagedApp(version);
  if (!existsSync(managedVersionApp)) {
    throw new Error(`managed app install failed: ${managedVersionApp} not found`);
  }

  ensureCurrentAppLink(managedVersionApp);
  pruneOldManagedApps(version);
  return managedVersionApp;
}

async function ensureRuntimeBinary(version) {
  const assetSuffix = resolveAssetSuffix(process.platform, process.arch);
  if (!assetSuffix) {
    throw new Error(
      `unsupported platform ${process.platform}/${process.arch}. Currently supported: darwin-arm64, linux-x64.`
    );
  }

  const url = `https://github.com/lightsofapollo/attn/releases/download/v${version}/attn-v${version}-${assetSuffix}`;
  const tempPath = `${runtimeBinaryPath}.tmp`;
  mkdirSync(runtimeDir, { recursive: true });
  await download(url, tempPath);
  chmodSync(tempPath, 0o755);
  renameSync(tempPath, runtimeBinaryPath);
  console.error(`attn: installed runtime binary ${runtimeBinaryPath}`);
}

function findGlobalAppInstall(version) {
  const candidates = [
    "/Applications/attn.app",
    join(userHome, "Applications", "attn.app"),
  ];
  for (const candidate of candidates) {
    const binary = join(candidate, "Contents", "MacOS", "attn");
    if (existsSync(candidate) && isExpectedBinaryVersion(binary, version)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Locate an already-installed `attn` we can hand off to instead of
 * downloading. Priority:
 *   1. $ATTN_BIN explicit override
 *   2. `attn` on PATH (via `command -v`)
 *   3. The ~/.local/bin alias this launcher installs on first run
 *   4. Common manual / package-manager install dirs (Homebrew, cargo)
 *
 * Each candidate is validated by `isUsableNativeBinary`, which rejects
 * anything inside this npm package (so a global `npm i -g attn` symlink,
 * whose realpath points back at bin/attn.js, can't cause infinite
 * recursion).
 */
function findNativeBinary(version) {
  const candidates = [];

  if (process.env.ATTN_BIN) {
    candidates.push(process.env.ATTN_BIN);
  }

  const onPath = whichAttn();
  if (onPath) {
    candidates.push(onPath);
  }

  candidates.push(
    installLinkPath, // ~/.local/bin/attn — the alias we install ourselves
    "/opt/homebrew/bin/attn",
    "/usr/local/bin/attn",
    join(userHome, ".cargo", "bin", "attn"),
  );

  for (const candidate of candidates) {
    if (isUsableNativeBinary(candidate, version)) {
      return candidate;
    }
  }
  return null;
}

/** Resolve `attn` on PATH without throwing. Returns null when not found. */
function whichAttn() {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? ["attn"] : ["-v", "attn"],
    { encoding: "utf8", shell: process.platform !== "win32" },
  );
  if (probe.status !== 0 || !probe.stdout) {
    return null;
  }
  const first = probe.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  return first || null;
}

/**
 * True when `candidate` is an executable we can safely exec as a real
 * `attn` — i.e. it exists, is executable, and (after symlink resolution)
 * does NOT live inside this npm package. The last check is the recursion
 * guard: a global `npm i -g attn` makes `attn` on PATH a symlink to
 * `<package>/bin/attn.js`; handing off to that would re-enter this script
 * forever.
 */
function isUsableNativeBinary(candidate, version) {
  if (!candidate) return false;
  try {
    accessSync(candidate, fsConstants.X_OK);
  } catch {
    return false;
  }
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return false;
  }
  // Recursion guard: never hand off to another copy of THIS launcher.
  // Two ways that happens:
  //   1. The candidate resolves to this exact file (a symlink to it).
  //   2. A global `npm i -g attn` makes `attn` on PATH a symlink to some
  //      package's `bin/attn.js`; any `.js` is a node launcher, not a
  //      native binary, so reject it.
  // A compiled binary under this repo's `target/` (dev builds) is fine —
  // it can't re-enter this script — so we deliberately DON'T reject the
  // whole package dir, only the launcher itself + the `bin/` dir + `.js`.
  try {
    if (resolved === realpathSync(__filename)) return false;
  } catch {
    /* __filename always resolves; ignore */
  }
  if (resolved.endsWith(".js")) return false;
  const binDirReal = (() => {
    try {
      return realpathSync(join(packageDir, "bin"));
    } catch {
      return join(packageDir, "bin");
    }
  })();
  if (resolved.startsWith(binDirReal + "/") || resolved === binDirReal) {
    return false;
  }
  return isExpectedBinaryVersion(resolved, version);
}

function isExpectedBinaryVersion(binary, version) {
  if (!binary || !existsSync(binary)) {
    return false;
  }
  if (process.env.ATTN_SKIP_NATIVE_VERSION_CHECK === "1") {
    return true;
  }
  const actual = readBinaryVersion(binary);
  const ok = actual === version;
  if (!ok && process.env.ATTN_DEBUG_LAUNCHER) {
    const label = actual ? `version ${actual}` : "unknown version";
    console.error(`attn: skipping ${binary} (${label}; need ${version})`);
  }
  return ok;
}

function readBinaryVersion(binary) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

function safeRemove(path) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function ensureCurrentAppLink(appPath) {
  mkdirSync(managedRoot, { recursive: true });
  try {
    if (existsSync(managedCurrentAppLink)) {
      unlinkSync(managedCurrentAppLink);
    }
  } catch {
    rmSync(managedCurrentAppLink, { recursive: true, force: true });
  }
  symlinkSync(appPath, managedCurrentAppLink);
}

async function installManagedApp(version) {
  const assetSuffix = resolveAssetSuffix(process.platform, process.arch);
  if (!assetSuffix) {
    throw new Error(
      `unsupported platform ${process.platform}/${process.arch}. Currently supported: darwin-arm64, linux-x64.`
    );
  }

  const appZipName = `attn-v${version}-${assetSuffix}.app.zip`;
  const appZipUrl = `https://github.com/lightsofapollo/attn/releases/download/v${version}/${appZipName}`;

  const versionDir = join(managedAppsRoot, version);
  const tempZip = join(versionDir, `${appZipName}.tmp`);
  const finalZip = join(versionDir, appZipName);
  const appPath = join(versionDir, "attn.app");

  mkdirSync(versionDir, { recursive: true });
  await download(appZipUrl, tempZip);
  renameSync(tempZip, finalZip);
  unzipApp(finalZip, versionDir);
  chmodSync(join(appPath, "Contents", "MacOS", "attn"), 0o755);
}

function unzipApp(zipPath, outDir) {
  const result = spawnSync(
    "/usr/bin/ditto",
    ["-x", "-k", zipPath, outDir],
    { stdio: "inherit" }
  );
  if (result.error) {
    throw new Error(`failed to extract app zip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`failed to extract app zip: ditto exited ${result.status}`);
  }
}

function pruneOldManagedApps(currentVersion) {
  try {
    const keep = new Set([currentVersion]);
    const listResult = spawnSync("ls", ["-1", managedAppsRoot], {
      encoding: "utf8",
    });
    if (listResult.status !== 0 || !listResult.stdout) {
      return;
    }
    const versions = listResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();

    for (const version of versions) {
      if (keep.has(version)) continue;
      rmSync(join(managedAppsRoot, version), { recursive: true, force: true });
    }
  } catch {
    // Best effort cleanup only.
  }
}

async function maybePromptInstallAlias() {
  if (!isInteractive) {
    return;
  }
  if (existsSync(installLinkPath)) {
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      "Install persistent `attn` command to ~/.local/bin for future runs? [Y/n] "
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized === "n" || normalized === "no") {
      return;
    }
    installAliasLauncher();
    console.error("attn: installed ~/.local/bin/attn");
  } catch (error) {
    console.error(`attn: failed to install alias: ${error.message}`);
  } finally {
    rl.close();
  }
}

function installAliasLauncher() {
  mkdirSync(dirname(installLauncherPath), { recursive: true });
  mkdirSync(installLinkDir, { recursive: true });

  const launcher = process.platform === "darwin"
    ? `#!/usr/bin/env bash
set -euo pipefail
APP_LINK="${managedCurrentAppLink}"
if [ ! -e "$APP_LINK" ]; then
  echo "attn: managed app is missing; run 'npx attnmd .' once to install." >&2
  exit 1
fi
BINARY="$APP_LINK/Contents/MacOS/attn"
HEADLESS=0
if [ "\${1:-}" = "review" ]; then
  HEADLESS=1
fi
for arg in "$@"; do
  case "$arg" in
    --status|--json|--check|--info|--eval|--click|--wait-for|--query|--fill)
      HEADLESS=1
      ;;
  esac
done
if [ "$HEADLESS" -eq 1 ]; then
  exec "$BINARY" "$@"
fi
# Resolve the first positional arg to an absolute path since open launches with cwd=/
RESOLVED_ARGS=()
PATH_RESOLVED=0
SKIP_NEXT=0
for arg in "$@"; do
  if [ "$SKIP_NEXT" -eq 1 ]; then
    RESOLVED_ARGS+=("$arg")
    SKIP_NEXT=0
    continue
  fi
  case "$arg" in
    --eval|--click|--wait-for|--query|--fill|--timeout)
      RESOLVED_ARGS+=("$arg")
      SKIP_NEXT=1
      ;;
    --*)
      RESOLVED_ARGS+=("$arg")
      ;;
    *)
      if [ "$PATH_RESOLVED" -eq 0 ]; then
        RESOLVED_ARGS+=("$(realpath "$arg" 2>/dev/null || echo "$arg")")
        PATH_RESOLVED=1
      else
        RESOLVED_ARGS+=("$arg")
      fi
      ;;
  esac
done
# No path arg provided — default to cwd so the app doesn't open at /
if [ "$PATH_RESOLVED" -eq 0 ]; then
  RESOLVED_ARGS+=("$(pwd)")
fi
exec /usr/bin/open "$APP_LINK" --args "\${RESOLVED_ARGS[@]}"
`
    : `#!/usr/bin/env bash
set -euo pipefail
BINARY="${runtimeBinaryPath}"
if [ ! -x "$BINARY" ]; then
  echo "attn: runtime binary is missing; run 'npx attnmd .' once to install." >&2
  exit 1
fi
exec "$BINARY" "$@"
`;

  writeFileSync(installLauncherPath, launcher, { mode: 0o755 });
  chmodSync(installLauncherPath, 0o755);

  if (existsSync(installLinkPath)) {
    unlinkSync(installLinkPath);
  }
  symlinkSync(installLauncherPath, installLinkPath);
}

function resolvePathArgs(args) {
  // `open` launches the app with cwd=/, so resolve relative paths to absolute
  // before forwarding. The first positional arg (not a flag or flag value) is the path.
  const flagsWithValue = new Set(["--eval", "--click", "--wait-for", "--query", "--fill", "--timeout"]);
  const resolved = [];
  let pathResolved = false;
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      resolved.push(arg);
      skipNext = false;
      continue;
    }
    if (arg.startsWith("--")) {
      resolved.push(arg);
      if (flagsWithValue.has(arg)) {
        skipNext = true;
      }
      continue;
    }
    if (!pathResolved) {
      resolved.push(resolve(arg));
      pathResolved = true;
    } else {
      resolved.push(arg);
    }
  }
  // No path arg provided — default to cwd so the app doesn't open at /
  if (!pathResolved) {
    resolved.push(process.cwd());
  }
  return resolved;
}

function isHeadlessInvocation(args) {
  return args[0] === "review" || args.some((arg) => HEADLESS_FLAGS.has(arg));
}

function run(cmd, args) {
  const child = spawnSync(cmd, args, {
    stdio: "inherit",
  });
  if (child.error) {
    throw new Error(`failed to launch ${cmd}: ${child.error.message}`);
  }
  process.exit(typeof child.status === "number" ? child.status : 1);
}

function resolveAssetSuffix(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }
  return null;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(
          new Error(`HTTP ${response.statusCode ?? "unknown"} while downloading ${url}`)
        );
        return;
      }

      const out = createWriteStream(destination, { mode: 0o755 });
      response.pipe(out);
      out.on("finish", () => {
        out.close();
        resolve();
      });
      out.on("error", reject);
    });

    request.on("error", reject);
  });
}
