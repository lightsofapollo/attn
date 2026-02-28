# macOS Release Setup

This project ships a signed macOS `.app` and `.dmg` without using Tauri.

## What is included

- `scripts/macos-build-bundle.sh`: builds `attn.app` with `cargo-bundle`
- `scripts/macos-sign-app.sh`: signs `attn.app` with Developer ID
- `scripts/macos-create-dmg.sh`: packages and optionally signs DMG
- `scripts/macos-notarize-dmg.sh`: notarizes and staples DMG
- `.github/workflows/test-signing.yml`: signing smoke test
- `.github/workflows/macos-desktop-test.yml`: build/sign/notarize artifact test

## Required GitHub Secrets

Set these in `Settings -> Secrets and variables -> Actions`:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` certificate export
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting `.p12`
- `KEYCHAIN_PASSWORD`: temporary keychain password for CI
- `APPLE_SIGNING_IDENTITY`: Developer ID identity string
- `APPLE_ID`: Apple developer account email (for notarization)
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for `notarytool`
- `APPLE_TEAM_ID`: Apple team ID

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

# 4) Optional notarize + staple
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDEFGHIJ"
scripts/macos-notarize-dmg.sh target/aarch64-apple-darwin/release/bundle/osx/attn.dmg
```

## CI test run

1. Run `Test Code Signing` workflow to validate cert/keychain/signing.
2. Run `macOS Desktop Build Test` workflow:
   - `mode=prod`
   - `target=aarch64-apple-darwin`
   - `notarize=true`

## Icon notes

- `icons/attn.icns` is currently a placeholder.
- Regenerate placeholder icon:
  ```bash
  scripts/generate-placeholder-icon.sh
  ```
- Replace with final branded icon before public release.
