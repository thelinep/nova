'use strict';
/* ===========================================================================
 * NOVA Runtime — Electron main process (Phase 5)
 *
 * Real, standards-correct Electron main-process code: it starts the same
 * server.js this whole project already runs (no separate server logic,
 * no duplicated routes) as a child process in-process via require() —
 * Electron's main process is a real Node process, so server.js's own
 * `require('node:sqlite')`/global fetch/node:http all work unmodified —
 * then opens a BrowserWindow pointing at it once it's healthy, using the
 * exact same readiness check packaging/launch.js uses.
 *
 * HONEST STATUS: this has never actually been run. `npm install electron`
 * inside packaging/electron 403s against the npm registry from both the
 * cloud build sandbox and the user's own device (see packaging/README.md
 * for the full, dual-checked account) — there is no Electron runtime
 * anywhere this project has been built to launch this file with. It is
 * real code written to Electron's documented API, not tested-and-working
 * code, and that distinction matters: don't read "packaging is done"
 * from this file's presence.
 * ========================================================================= */
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

const PORT = Number(process.env.PORT) || 8787;
const URL = `http://127.0.0.1:${PORT}`;

function checkHealth() {
  return new Promise(resolve => {
    const req = http.get(`${URL}/api/health`, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function createWindow() {
  // server.js self-starts on require() (it calls server.listen() at module
  // load, same as `node server.js` on the CLI) — requiring it from inside
  // Electron's own Node process is genuinely simpler than spawning a
  // second `node` process and piping its output, and it's still the real,
  // unmodified server.
  require(path.join(__dirname, '..', '..', 'server.js'));

  const healthy = await waitForHealthy(15000);
  if (!healthy) {
    console.error(`NOVA Runtime did not report healthy at ${URL}/api/health within 15s.`);
  }

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'NOVA Runtime',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(URL);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
