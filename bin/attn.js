#!/usr/bin/env node

const {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
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

  let appPath = null;
  if (process.platform === "darwin") {
    try {
      appPath = await resolveAppPath(version);
    } catch (error) {
      console.error(`attn: app install unavailable (${error.message}); falling back to binary.`);
    }
  }

  if (!appPath) {
    if (!existsSync(runtimeBinaryPath)) {
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
  const globalApp = findGlobalAppInstall();
  if (globalApp) {
    return globalApp;
  }

  const managedVersionApp = join(managedAppsRoot, version, "attn.app");
  if (existsSync(managedVersionApp)) {
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

function findGlobalAppInstall() {
  const candidates = [
    "/Applications/attn.app",
    join(userHome, "Applications", "attn.app"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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
  return resolved;
}

function isHeadlessInvocation(args) {
  return args.some((arg) => HEADLESS_FLAGS.has(arg));
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
