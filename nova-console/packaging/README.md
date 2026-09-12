# NOVA Runtime — desktop packaging (Phase 5)

Phase 5's roadmap card says "ships as a Tauri and Electron desktop app."
This directory is the honest account of what that actually means in the
environments this project has been built and verified in — following the
same pattern every earlier phase used when its stack hit a real,
dual-checked constraint (Phase 1: SQLite/HTTP substitutions, Phase 2:
hand-rolled vector search, Phase 3: hand-rolled MCP protocol): verify the
constraint directly, and if the suggested stack is genuinely unreachable,
build the real underlying mechanism by hand rather than fake the result.

## What was actually checked, and where

| Check | Cloud build sandbox | User's linked device |
|---|---|---|
| `npm view electron version` | **403** from `registry.npmjs.org` | **403** |
| `curl https://crates.io/api/v1/crates/tauri` | **403** (`CONNECT tunnel failed`) | **403** (`Received HTTP code 403 from proxy after CONNECT`) |
| `rustc --version` / `cargo --version` | present (1.95.0) | **not installed at all** |
| Tauri-compatible webview (`webkit2gtk`) | not found via `ldconfig -p` (only unrelated `libQt5WebKit*`) | not checked (no cargo to build against anyway) |

Both `npm install electron` and `cargo build` (which Tauri needs) require
reaching a package registry that is blocked in both places this project
runs. That isn't a "didn't try" gap — both registries were queried
directly and both returned `403`, and the device additionally has no Rust
toolchain to fall back to even if crates.io became reachable. Neither a
real Electron build nor a real Tauri build is possible in either available
environment today.

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
- **`tauri/`** — a real, standards-correct Tauri v2 project: `Cargo.toml`,
  `tauri.conf.json` (schema-valid v2 config pointing its window at NOVA
  Runtime's own URL), `build.rs`, and `src/main.rs`, which spawns
  `node server.js` as a child process via `std::process::Command`, polls
  its health endpoint with a minimal hand-rolled TCP client (not worth a
  crate for one health check), and only then opens the window. **It has
  never actually been compiled** — `cargo build` needs crates.io, which is
  blocked, and the one available device has no `rustc`/`cargo` installed
  regardless.
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

## Neither Tauri's nor Electron's config was invented to "look done"

Both configs are written directly against their tools' documented shapes
(Tauri 2's schema-validated `tauri.conf.json`, Electron's standard
`main.js`/`BrowserWindow` API) using the same architecture the working
`launch.js` and Phase 4's real local process patterns already established
in this project — spawn the real, unmodified `server.js`, wait for its
real health check, then show a window at its real URL. If the registry
block lifts, `npm install` in `electron/` or `cargo build` in `tauri/` is
the only remaining step, not a rewrite.

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
