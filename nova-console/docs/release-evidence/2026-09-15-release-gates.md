# NOVA Runtime release-gate evidence

Recorded 2026-09-15 from the local ARM64 macOS checkout.

## Verified

- Backend, integration, planner, collector, workspace, Git and security tests: 45/45 passed.
- Playwright Chromium UI tests: 10/10 passed.
- Tauri/Rust tests: 15/15 passed.
- Packaged `.app` built with `CARGO_NET_OFFLINE=true cargo tauri build --bundles app --no-sign`.
- Packaged app launched from `target/release/bundle/macos/NOVA Runtime.app`.
- App started its bundled `Contents/Resources/node/bin/node` runtime.
- `GET http://127.0.0.1:8787/api/health` returned `{ "ok": true }` from the bundled server.
- Startup migration writes an idempotent `runtime-schema-version` marker.
- Bundled runtime falls back to a system `node` only for development bundles without the resource.
- The packaged health probe uses NOVA's exact `127.0.0.1:8787` authority; the previous packaged-launch abort was reproduced and repaired.
- Normal reopen and forced `open -n` both leave exactly one Tauri shell and one bundled server.
- A forced shell crash leaves the bundled server healthy; relaunch replaces the stale instance lock and adopts that exact server PID after verifying its application-data directory.
- A native macOS quit event after recovery terminates both the adopted server and the Tauri shell.
- The NOVA status item is visibly present in a native desktop capture.
- The status-item menu exposes Show NOVA, Hide NOVA, Refresh workspace and Quit NOVA. Each action was clicked through macOS Accessibility: hide removed the main window, show restored and focused it, refresh retained a healthy window/server, and quit stopped both packaged processes.
- Provider Browser was opened from the packaged UI. Opening Codex created and focused `NOVA Provider Browser`; opening Claude reused that same window and kept the native window count at two.
- Local Workspace opened the native macOS folder chooser titled `Approve a local folder for NOVA`. The dialog exposed Cancel and Choose; cancellation returned to a healthy app without changing an approval.

## Not certified

- `security find-identity -v -p codesigning` reported zero valid signing identities.
- The current app is ad-hoc/linker-signed and was built with `--no-sign`.
- Developer ID signing and Apple notarization were not performed.
- Clean-machine installation and first-run migration were not independently exercised.
- No update endpoint, signed update manifest, or update-channel configuration is present yet.
- The general computer-control attachment still timed out, but macOS Accessibility scripting completed all required packaged-window journeys.

## Required release inputs

1. Developer ID Application certificate and private key in the signing keychain.
2. Apple notarization credentials or an App Store Connect API key.
3. A clean macOS test machine or disposable VM for install, upgrade, uninstall and restore drills.
4. A signed update manifest and hosted update endpoint with rollback policy.
5. A repeatable CI-capable macOS Accessibility harness for these packaged-window journeys.
