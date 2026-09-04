/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['sqlite3', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  },
};

module.exports = nextConfig;
