import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const runtimeDir = join(packageDir, "bin-runtime");
const runtimeBinaryPath = join(runtimeDir, "attn");
const tempPath = `${runtimeBinaryPath}.tmp`;

if (process.env.ATTN_SKIP_DOWNLOAD === "1") {
  console.log("attn: skipping binary download (ATTN_SKIP_DOWNLOAD=1).");
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const assetSuffix = resolveAssetSuffix(process.platform, process.arch);

if (!assetSuffix) {
  console.warn(
    `attn: unsupported platform ${process.platform}/${process.arch}. ` +
      "Currently supported: darwin-arm64, linux-x64."
  );
  process.exit(0);
}

const url = `https://github.com/lightsofapollo/attn/releases/download/v${version}/attn-v${version}-${assetSuffix}`;
console.log(`attn: downloading ${url}`);

mkdirSync(runtimeDir, { recursive: true });
safeRemove(tempPath);

download(url, tempPath)
  .then(() => {
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, runtimeBinaryPath);
    console.log(`attn: installed ${runtimeBinaryPath}`);
  })
  .catch((error) => {
    safeRemove(tempPath);
    console.warn(`attn: runtime prefetch failed: ${error.message}`);
    console.warn("attn: continuing; runtime will be installed on first launch.");
    process.exit(0);
  });

function resolveAssetSuffix(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }
  return null;
}

function safeRemove(path) {
  if (existsSync(path)) {
    rmSync(path);
  }
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
          new Error(
            `HTTP ${response.statusCode ?? "unknown"} while downloading ${url}`
          )
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
