# NOVA Runtime — desktop packaging (Phase 5)

Phase 5's roadmap card says "ships as a Tauri and Electron desktop app."
This directory is the honest account of what that actually means in the
environments this project has been built and verified in — following the
same pattern every earlier phase used when its stack hit a real,
dual-checked constraint (Phase 1: SQLite/HTTP substitutions, Phase 2:
hand-rolled vector search, Phase 3: hand-rolled MCP protocol): verify the
constraint directly, and if the suggested stack is genuinely unreachable,
build the real underlying mechanism by hand rather than fake the result.

## Current verified status

The Tauri macOS application now builds and has been launched successfully.
The unsigned artifact is `packaging/tauri/target/release/bundle/macos/NOVA Runtime.app`.
It bundles the server, libraries, skills, MCP servers, and public assets as
Tauri resources, stores SQLite data in the macOS application-data directory,
and terminates its child server on normal application exit. `cargo check
--offline` and `cargo tauri build --bundles app --no-sign` pass.

The app is ad-hoc/unsigned and has not been notarized. A distributable DMG
still requires a working macOS disk-image environment; the local helper could
not mount one here and its partial output was removed.

## Release gate

The runtime now has a fail-closed local release-evidence gate. It cannot
report a public release ready until current, checksum-bound evidence exists
for all of: tests, artifact manifest, Developer ID code signing, Apple
notarization, clean-machine installation, and a signed update manifest.
Recording a file after it changes invalidates that evidence. This gate does
not perform signing or notarization; those actions require the release
operator's Apple credentials and explicit submission.

Run `npm run release:check` from `nova-console` to inspect the current
gate. It exits non-zero until all required evidence is current.

## What was actually checked, and where

| Check | Cloud build sandbox | User's linked device |
|---|---|---|
| `npm view electron version` | **403** from `registry.npmjs.org` | **403** |
| `curl https://crates.io/api/v1/crates/tauri` | **403** (`CONNECT tunnel failed`) | **403** (`Received HTTP code 403 from proxy after CONNECT`) |
| `rustc --version` / `cargo --version` | present (1.91.0) | present (1.91.0) |
| Tauri-compatible webview (`webkit2gtk`) | not found (Linux) | macOS WebKit available |

Electron remains unbuilt because its runtime is not installed. The Tauri
dependency set was available in the local Cargo cache and the macOS app was
compiled offline.

## What's in this directory, and its honest status

- **`electron/`** — a real, standards-correct Electron app: `main.js`
  requires the project's own unmodified `server.js` in-process, waits on
  its real `/api/health`, then opens a `BrowserWindow` at it.
  `package.json` declares `electron`/`electron-builder` as devDependencies
  and a real `electron-builder` config for dmg/AppImage/nsis targets. If
  registry access were available, `npm install && npm run dist` inside
  this folder would produce real installers. **It has never actually been
  run** — there is no Electron runtime anywhere this project has been
  built to launch it with.
- **`tauri/`** — the verified Tauri v2 macOS shell described above. It
  bundles the runtime resources and stores user data outside the app bundle.
- **`launch.js`** — the one deliverable in this directory that actually
  runs, right now, in the same sandboxes that block the two above. Zero
  dependencies (same as `server.js` itself): it spawns `node server.js`,
  waits on the real health check, and opens the OS's default browser at
  the running console. Run it with:

  ```
  node packaging/launch.js
  ```

  This is a genuinely smaller thing than a packaged desktop app — no app
  bundle, no dock/taskbar icon, no dedicated window chrome, just your
  regular browser pointed at the real local server automatically instead
  of by hand. It is not a substitute claimed to be equivalent to
  `electron/` or `tauri/`; it's what's true today, named as such.

## Runtime architecture

The verified Tauri app spawns the real `server.js`, waits for its real
health route, and then shows its local URL. It packages the server and its
resources but deliberately does not include a Node runtime. A signed public
release therefore still needs a bundled Node sidecar, a Developer ID signing
identity, notarization, and a verified installer build.

## If you want to actually build one of these

- **Electron**: from a machine with normal npm registry access,
  `cd packaging/electron && npm install && npm start` (or `npm run dist`
  for installers).
- **Tauri**: from a machine with `rustc`/`cargo` and normal crates.io
  access, plus a Tauri-supported system webview (WebKitGTK on Linux, WebView2
  on Windows — bundled with the OS on macOS), `cd packaging/tauri && cargo
  tauri dev` (or `cargo tauri build`; needs the `tauri-cli` installed —
  `cargo install tauri-cli`).
- Either way runs the exact same `server.js` and `public/index.html` this
  whole project already is — packaging never forked the app's logic, only
  wrapped it.
