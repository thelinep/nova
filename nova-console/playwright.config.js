'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const port = Number(process.env.NOVA_E2E_PORT || 8791);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const workspaceDir = process.env.NOVA_E2E_WORKSPACE || fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-workspace-'));
process.env.NOVA_E2E_WORKSPACE = workspaceDir;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'node --no-warnings tests/e2e-server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { ...process.env, PORT: String(port), NOVA_COMFY_AUTOSTART: '0', NOVA_E2E_WORKSPACE: workspaceDir },
  },
});
