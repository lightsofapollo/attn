#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const binaryPath = join(__dirname, "..", "bin-runtime", "attn");

if (!existsSync(binaryPath)) {
  console.error("attn: runtime binary is missing.");
  console.error(
    "Reinstall with npm or set ATTN_SKIP_DOWNLOAD=0 so postinstall can fetch binaries."
  );
  process.exit(1);
}

const child = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

if (child.error) {
  console.error(`attn: failed to launch binary: ${child.error.message}`);
  process.exit(1);
}

if (typeof child.status === "number") {
  process.exit(child.status);
}

process.exit(1);
