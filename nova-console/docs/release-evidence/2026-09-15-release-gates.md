# NOVA Runtime release-gate evidence

Recorded 2026-09-15 from the local ARM64 macOS checkout.

## Verified

- Backend, integration, planner, collector, workspace, Git and security tests: 45/45 passed.
- Playwright Chromium UI tests: 10/10 passed.
- Tauri/Rust tests: 12/12 passed.
- Packaged `.app` built with `CARGO_NET_OFFLINE=true cargo tauri build --bundles app --no-sign`.
- Packaged app launched from `target/release/bundle/macos/NOVA Runtime.app`.
- App started its bundled `Contents/Resources/node/bin/node` runtime.
- `GET http://127.0.0.1:8787/api/health` returned `{ "ok": true }` from the bundled server.
- Startup migration writes an idempotent `runtime-schema-version` marker.
- Bundled runtime falls back to a system `node` only for development bundles without the resource.

## Not certified

- `security find-identity -v -p codesigning` reported zero valid signing identities.
- The current app is ad-hoc/linker-signed and was built with `--no-sign`.
- Developer ID signing and Apple notarization were not performed.
- Clean-machine installation and first-run migration were not independently exercised.
- No update endpoint, signed update manifest, or update-channel configuration is present yet.
- Native accessibility attachment to the packaged window timed out twice; menu-bar, folder-picker, Provider Browser and restart interactions remain unverified by direct UI automation.

## Required release inputs

1. Developer ID Application certificate and private key in the signing keychain.
2. Apple notarization credentials or an App Store Connect API key.
3. A clean macOS test machine or disposable VM for install, upgrade, uninstall and restore drills.
4. A signed update manifest and hosted update endpoint with rollback policy.
5. A repeatable native UI test harness that can attach to the packaged Tauri window.
