'use strict';

const { defineConfig, devices } = require('@playwright/test');

const port = Number(process.env.NOVA_E2E_PORT || 8791);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: 'coding-studio.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    video: { mode: 'on', size: { width: 1440, height: 900 } },
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'node --no-warnings tests/e2e-server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { ...process.env, PORT: String(port), NOVA_COMFY_AUTOSTART: '0' },
  },
});
