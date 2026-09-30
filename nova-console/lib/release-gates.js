'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { uid } = require('./exec-log');
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const REQUIRED = ['tests', 'artifact-manifest', 'codesign', 'notarization', 'clean-install', 'update-manifest'];
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function record(store, input) {
  const kind = String(input.kind || ''); if (!REQUIRED.includes(kind)) throw error('Unsupported release evidence kind.');
  const file = path.resolve(String(input.file || '')); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw error('Evidence file must exist.');
  const now = new Date().toISOString(); const item = { id: uid('release_evidence'), kind, file, sha256: digest(file), recordedAt: now, note: String(input.note || '').slice(0,500) };
  store.put('releaseEvidence', item); return item;
}
function check(store) {
  const evidence = store.all('releaseEvidence');
  const latest = Object.fromEntries(REQUIRED.map(kind => [kind, evidence.filter(x => x.kind === kind).sort((a,b) => b.recordedAt.localeCompare(a.recordedAt))[0] || null]));
  const missing = REQUIRED.filter(kind => !latest[kind]);
  const staleOrChanged = Object.values(latest).filter(item => item && (!fs.existsSync(item.file) || digest(item.file) !== item.sha256)).map(item => item.kind);
  return { releaseReady: missing.length === 0 && staleOrChanged.length === 0, required: REQUIRED, missing, staleOrChanged, evidence: latest, checkedAt: new Date().toISOString() };
}

module.exports = { record, check, REQUIRED };
