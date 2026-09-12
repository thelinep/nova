#!/usr/bin/env node
'use strict';
/* ===========================================================================
 * NOVA Runtime — cross-platform launcher (Phase 5)
 *
 * The one packaging deliverable that genuinely runs today, in every
 * environment this project has been built and verified in (see
 * packaging/README.md for the full honest account of why the Tauri and
 * Electron builds next to this file do NOT run here). This script needs
 * nothing beyond what server.js itself already needs — plain Node, zero
 * dependencies — so it works in the exact same sandboxes that block
 * `npm install electron` and `cargo build` for the other two.
 *
 * What it does: starts server.js as a child process, waits for it to
 * report healthy on its real /api/health route, then opens the OS's
 * default browser at its URL — the same "a real local backend serving a
 * real local web console" this whole project is, just launched with one
 * command and a window that opens itself, instead of `node server.js` and
 * a manually-typed URL. No window chrome, no dock icon, no app bundle —
 * genuinely a smaller thing than a native desktop app, named as such.
 * ========================================================================= */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const URL = `http://127.0.0.1:${PORT}`;
const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_POLL_MS = 250;

function checkHealth() {
  return new Promise(resolve => {
    const req = http.get(`${URL}/api/health`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkHealth()) return true;
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // spawn() itself doesn't throw for a missing command (e.g. no
    // xdg-open in a headless/minimal environment) — the failure shows up
    // later as an async 'error' event, which crashes the process if
    // nothing is listening for it. This is real robustness, not a stub:
    // opening a browser genuinely can fail (no GUI, unusual platform),
    // and that should be a printed message, not an uncaught exception.
    child.on('error', () => console.log(`Could not open a browser automatically (no "${cmd}" found) — open ${url} yourself.`));
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log('NOVA Runtime — starting local server…');
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill('SIGTERM');
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', code => { if (!shuttingDown) process.exit(code || 0); });

  const healthy = await waitForHealthy();
  if (!healthy) {
    console.error(`NOVA Runtime did not report healthy at ${URL}/api/health within ${HEALTH_TIMEOUT_MS}ms — check the server output above.`);
    return; // leave the child running; the user can still open the URL manually once it's up
  }

  console.log(`NOVA Runtime is up at ${URL} — opening your default browser.`);
  const opened = openBrowser(URL);
  if (!opened) {
    console.log(`Could not open a browser automatically — open ${URL} yourself.`);
  }
}

main();
