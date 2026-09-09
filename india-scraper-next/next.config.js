/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.BRAHMINI_NEXT_DIST_DIR || ".next",
  serverExternalPackages: ['sqlite3', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
};

module.exports = nextConfig;
