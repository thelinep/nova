#!/bin/bash
# Double-click to pack the whole NOVA Runtime into nova-console/packaging/dist/:
#   - NOVA Runtime.app (Tauri, with its own Node runtime), zipped, and a .dmg when macOS can make one;
#   - a portable folder (tar.gz) that starts NOVA in your browser with the same bundled Node.
# Runs the unit tests first (temporary data only) and stops if any fail. The app is unsigned and
# not notarized, so it is for this Mac and machines you trust. Takes a few minutes (longer the first time).
ROOT="$(cd "$(dirname "$0")" && pwd)"
NOVA="$ROOT/nova-console"
cd "$NOVA" || exit 1
pause(){ read -r -t 600 -p "Press Return to close." _; }
fail(){ echo; echo "✗ $1"; pause; exit 1; }
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

FREE=$(df -Pk "$NOVA" | awk 'NR==2{print int($4/1048576)}')
[ "${FREE:-0}" -ge 3 ] || fail "Only ${FREE} GB free; packing needs about 3 GB. Free some space and try again."
command -v node >/dev/null || fail "Node is not installed (NOVA needs Node 22.5 or newer)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || fail "Node $(node -v) is too old; NOVA needs 22.5 or newer."

VERSION=$(node -p "require('./package.json').version")
SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)
ARCH=$(uname -m)
NAME="NOVA-Runtime-$VERSION-$SHA-mac-$ARCH"
DIST="$NOVA/packaging/dist"
mkdir -p "$DIST"
LOG="$DIST/$NAME-build.log"
exec > >(tee "$LOG") 2>&1
echo "== Packing $NAME"

echo "== 1/5 Unit tests"
echo "   Node $(node -v) at $(command -v node)"
TLOG="$DIST/$NAME-tests.log"
node --test --test-reporter=tap tests/*.test.js > "$TLOG" 2>&1; TEST_EXIT=$?
grep -E "^# (tests|pass|fail)|^not ok" "$TLOG" | sed 's/^/   /'
[ "$TEST_EXIT" -eq 0 ] || fail "Tests failed; nothing was packed. Details: $TLOG"

echo "== 2/5 Bundled Node runtime (official nodejs.org build, so it runs on Macs without Homebrew)"
BUNDLED="$NOVA/packaging/runtime/node/bin/node"
NODEV=$(node -v); NARCH=$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)
self_contained(){ [ -x "$1" ] && ! otool -L "$1" 2>/dev/null | tail -n +2 | grep -qvE '^[[:space:]]*/(usr/lib|System)/'; }
if ! self_contained "$BUNDLED" || [ "$("$BUNDLED" -v 2>/dev/null)" != "$NODEV" ]; then
  echo "   Downloading Node $NODEV for macOS $NARCH from nodejs.org…"
  TMPN=$(mktemp -d); TGZ="node-$NODEV-darwin-$NARCH.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$NODEV/$TGZ" -o "$TMPN/$TGZ" && curl -fsSL "https://nodejs.org/dist/$NODEV/SHASUMS256.txt" -o "$TMPN/SHASUMS256.txt" \
    || fail "Could not download Node $NODEV from nodejs.org."
  ( cd "$TMPN" && grep " $TGZ\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null ) || fail "The Node download did not match its published checksum."
  tar -xzf "$TMPN/$TGZ" -C "$TMPN" && mkdir -p "$(dirname "$BUNDLED")" && cp "$TMPN/node-$NODEV-darwin-$NARCH/bin/node" "$BUNDLED" && chmod 755 "$BUNDLED" || fail "Could not unpack Node."
  rm -rf "$TMPN"
fi
self_contained "$BUNDLED" || fail "The bundled Node still depends on Homebrew libraries."
echo "   Node $("$BUNDLED" -v), self-contained"

echo "== 3/5 NOVA Runtime.app (Tauri)"
APP=""
if command -v cargo >/dev/null; then
  if ! cargo tauri --version >/dev/null 2>&1; then
    echo "   Installing the Tauri command line tool (one time)…"
    cargo install tauri-cli --version '^2' --locked || echo "   Could not install tauri-cli."
  fi
  if cargo tauri --version >/dev/null 2>&1; then
    ( cd packaging/tauri && cargo tauri build --bundles app --no-sign ) && APP="$NOVA/packaging/tauri/target/release/bundle/macos/NOVA Runtime.app"
  fi
else
  echo "   Rust (cargo) is not installed, so the .app is skipped. Install it from https://rustup.rs to build the app."
fi
if [ -n "$APP" ] && [ -d "$APP" ]; then
  codesign --force --deep -s - "$APP" 2>/dev/null
  rm -f "$DIST/$NAME.app.zip"; ditto -c -k --norsrc --noextattr --keepParent "$APP" "$DIST/$NAME.app.zip" && echo "   → $NAME.app.zip"
  echo "== 4/5 Disk image"
  rm -f "$DIST/$NAME.dmg"
  STAGE=$(mktemp -d); cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  if hdiutil create -volname "NOVA Runtime" -srcfolder "$STAGE" -ov -format UDZO "$DIST/$NAME.dmg" >/dev/null 2>&1; then echo "   → $NAME.dmg"; else echo "   macOS could not make a disk image here; use the .zip."; fi
  rm -rf "$STAGE"
else
  echo "   App not built; the portable pack below still works."
  echo "== 4/5 Disk image (skipped)"
fi

echo "== 5/5 Portable folder"
P=$(mktemp -d)/"NOVA Runtime"
mkdir -p "$P/node/bin" "$P/scripts" "$P/docs"
cp -X server.js package.json "$P/" && cp -RX lib skills mcp-servers public "$P/" && cp scripts/kokoro-say.py "$P/scripts/" && cp docs/NOVA_USER_GUIDE.md "$P/docs/" \
  && cp "$BUNDLED" "$P/node/bin/node" && cp "packaging/portable/Start NOVA.command" packaging/portable/README.txt "$P/" && chmod +x "$P/Start NOVA.command" "$P/node/bin/node" \
  || fail "Could not assemble the portable folder."
find "$P" -name .DS_Store -delete
COPYFILE_DISABLE=1 tar -C "$(dirname "$P")" -czf "$DIST/$NAME-portable.tar.gz" "NOVA Runtime" && echo "   → $NAME-portable.tar.gz"
T=$(mktemp -d)
( cd "$(dirname "$P")" && PORT=0 DATA_DIR="$T" NOVA_LIBRARY_DIR="$T/library" "./NOVA Runtime/node/bin/node" --no-warnings -e "setTimeout(()=>{console.log('   ! no listening event within 20 s');process.exit(1)},20000).unref(); const {server}=require('./NOVA Runtime/server.js'); server.on('listening',()=>{console.log('   Portable pack starts: OK'); process.exit(0)})" ) || echo "   ! The portable pack did not start cleanly; see above."
rm -rf "$T"
rm -rf "$(dirname "$P")"

echo; echo "== Done. Files in nova-console/packaging/dist:"; ls -lh "$DIST" | awk 'NR>1{print "   "$5"  "$9" "$10" "$11}'
open "$DIST"
pause
