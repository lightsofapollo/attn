# Release Setup

This project ships:
- signed/notarized macOS `.dmg` on every tag release
- tag-based GitHub Releases with `attn` CLI binaries
- crates.io publishing for `cargo install attn`
- npm package publishing for `npx attnmd`

## What is included

- `scripts/macos-build-bundle.sh`: builds `attn.app` with `cargo-bundle`
- `scripts/macos-sign-app.sh`: signs `attn.app` with Developer ID
- `scripts/macos-create-dmg.sh`: packages and optionally signs DMG
- `scripts/macos-notarize-dmg.sh`: notarizes and staples DMG
- `.github/workflows/test-signing.yml`: signing smoke test
- `.github/workflows/release.yml`: build release binaries on tag push (`v*`), sign/notarize DMG, publish crate, and publish npm
- `.github/workflows/npm-publish.yml`: manual fallback publisher (workflow_dispatch or release events)

## Required GitHub Secrets

Set these in `Settings -> Secrets and variables -> Actions`:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` certificate export
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting `.p12`
- `KEYCHAIN_PASSWORD`: temporary keychain password for CI
- `APPLE_SIGNING_IDENTITY`: Developer ID identity string
- `APPLE_ID`: Apple developer account email (for notarization)
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for `notarytool`
- `APPLE_TEAM_ID`: Apple team ID
- `CARGO_REGISTRY_TOKEN`: crates.io API token with publish rights for crate `attn`

## Local prerequisites (macOS)

1. Install Rust + Xcode command line tools.
2. Install `cargo-bundle`:
   ```bash
   cargo install cargo-bundle --locked
   ```
3. Install web dependencies once:
   ```bash
   cd web && npm ci
   ```

## Local build / sign / notarize flow

```bash
# 1) Build app bundle
scripts/macos-build-bundle.sh prod aarch64-apple-darwin

# 2) Sign app bundle
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Org (TEAMID)"
scripts/macos-sign-app.sh target/aarch64-apple-darwin/release/bundle/osx/attn.app

# 3) Create DMG (signed if APPLE_SIGNING_IDENTITY is set)
scripts/macos-create-dmg.sh target/aarch64-apple-darwin/release/bundle/osx/attn.app

# 4) Notarize + staple
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDEFGHIJ"
scripts/macos-notarize-dmg.sh target/aarch64-apple-darwin/release/bundle/osx/attn.dmg
```

## CI test run

1. Run `Test Code Signing` workflow to validate cert/keychain/signing.
2. Run a full macOS build/sign/notarize test without publishing:
   ```bash
   gh workflow run release.yml --ref main
   ```
   This `workflow_dispatch` path builds and notarizes artifacts, but skips GitHub Release, crates.io, and npm publishing.
3. Push a version tag (`v*`) and verify `Release` workflow completes.

## GitHub release flow (tag-based)

1. Bump versions in source (`Cargo.toml` and root `package.json`) as needed.
2. Run and commit lock-safe checks:
   ```bash
   cargo check --locked
   git add Cargo.toml Cargo.lock package.json
   git commit -m "Bump release versions"
   ```
3. Create and push a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. `Release` workflow runs automatically and uploads:
   - `attn-v<VERSION>-darwin-arm64`
   - matching `.sha256` files
   - `attn-v<VERSION>-darwin-arm64.dmg` and checksum
5. A GitHub Release for the tag is created/updated with those assets.
6. The same workflow publishes crate `attn` to crates.io.
7. The same workflow publishes npm package `attnmd`.

## npm publish flow (`npx attnmd`)

1. Publish is triggered when a GitHub Release is marked `published`.
2. `Publish npm` workflow checks out the tag, sets `package.json` version from tag, and runs:
   ```bash
   npm publish --access public
   ```
   via npm trusted publishing (OIDC). Re-enable `--provenance` after the repository is public.
3. npm package `postinstall` downloads the matching binary from GitHub Releases.
4. `npx attnmd` then executes the downloaded runtime binary.
5. Global installs still expose `attn` as the command:
   ```bash
   npm i -g attnmd
   attn --help
   ```

## Icon notes

- `icons/attn.icns` is currently a placeholder.
- Regenerate placeholder icon:
  ```bash
  scripts/generate-placeholder-icon.sh
  ```
- Replace with final branded icon before public release.
