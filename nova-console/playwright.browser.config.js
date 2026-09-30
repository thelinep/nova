'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test',
  testMatch: 'browser.spec.js',
  fullyParallel: false,
  workers: 1,
  use: { headless: true, acceptDownloads: true },
});
