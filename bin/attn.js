#!/usr/bin/env node

const {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const { createInterface } = require("node:readline/promises");
const https = require("node:https");

const packageDir = join(__dirname, "..");
const runtimeDir = join(packageDir, "bin-runtime");
const binaryPath = join(runtimeDir, "attn");
const packageJsonPath = join(packageDir, "package.json");
const installRoot = join(homedir(), ".local", "share", "attn");
const installBinaryPath = join(installRoot, "bin", "attn");
const installLinkDir = join(homedir(), ".local", "bin");
const installLinkPath = join(installLinkDir, "attn");
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const isNpxInvocation = process.env.npm_execpath?.includes("npx") || process.argv[1]?.includes("attnmd");

main().catch((error) => {
  console.error(`attn: ${error.message}`);
  process.exit(1);
});

async function main() {
  if (!existsSync(binaryPath)) {
    await ensureRuntimeBinary();
  }

  if (!existsSync(binaryPath)) {
    throw new Error("runtime binary is missing after download attempt.");
  }

  await maybePromptInstallAlias();
  run(binaryPath, process.argv.slice(2));
}

async function ensureRuntimeBinary() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = packageJson.version;
  const assetSuffix = resolveAssetSuffix(process.platform, process.arch);

  if (!assetSuffix) {
    throw new Error(
      `unsupported platform ${process.platform}/${process.arch}. Currently supported: darwin-arm64.`
    );
  }

  const url = `https://github.com/lightsofapollo/attn/releases/download/v${version}/attn-v${version}-${assetSuffix}`;
  const tempPath = `${binaryPath}.tmp`;
  mkdirSync(runtimeDir, { recursive: true });
  await download(url, tempPath);
  chmodSync(tempPath, 0o755);
  renameSync(tempPath, binaryPath);
  console.error(`attn: installed runtime ${binaryPath}`);
}

async function maybePromptInstallAlias() {
  if (!isInteractive || !isNpxInvocation) {
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
    const answer = await rl.question("Install `attn` command to ~/.local/bin for future runs? [Y/n] ");
    const normalized = answer.trim().toLowerCase();
    if (normalized === "n" || normalized === "no") {
      return;
    }
    installAlias();
    console.error("attn: installed ~/.local/bin/attn");
  } catch (error) {
    console.error(`attn: failed to install alias: ${error.message}`);
  } finally {
    rl.close();
  }
}

function installAlias() {
  mkdirSync(dirname(installBinaryPath), { recursive: true });
  mkdirSync(installLinkDir, { recursive: true });
  copyFileSync(binaryPath, installBinaryPath);
  chmodSync(installBinaryPath, 0o755);

  if (existsSync(installLinkPath)) {
    unlinkSync(installLinkPath);
  }
  symlinkSync(installBinaryPath, installLinkPath);
}

function run(cmd, args) {
  const child = spawnSync(cmd, args, {
    stdio: "inherit",
  });

  if (child.error) {
    console.error(`attn: failed to launch binary: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(typeof child.status === "number" ? child.status : 1);
}

function resolveAssetSuffix(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
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
