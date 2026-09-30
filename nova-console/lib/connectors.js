'use strict';

const { uid } = require('./exec-log');
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const SUPPORTED = new Set(['github']);

function saveProfile(store, input) {
  const provider = String(input.provider || '').toLowerCase(); if (!SUPPORTED.has(provider)) throw error('Supported connector providers: github.');
  const id = input.id ? String(input.id) : uid('connector'); const now = new Date().toISOString();
  const prior = store.get('connectorProfiles', id);
  const profile = { id, provider, label: String(input.label || 'GitHub').slice(0,120), baseUrl: String(input.baseUrl || 'https://api.github.com').replace(/\/$/, ''), secretId: input.secretId ? String(input.secretId) : prior?.secretId || null, scopes: ['pull_requests:write', 'checks:read'], status: input.secretId ? 'configured' : (prior?.status || 'needs-secret'), createdAt: prior?.createdAt || now, updatedAt: now };
  store.put('connectorProfiles', profile); return publicProfile(profile);
}
function publicProfile(profile) { const { secretId, ...safe } = profile; return { ...safe, hasSecret: Boolean(secretId) }; }
function listProfiles(store) { return store.all('connectorProfiles').map(publicProfile); }

module.exports = { saveProfile, listProfiles, publicProfile };
