/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sqlite3', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
};

module.exports = nextConfig;
