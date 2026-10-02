'use strict';
/* ===========================================================================
 * Device identity: who is acting, from which machine
 *
 * NOVA Everywhere (docs/architecture/nova-everywhere.md) identifies every
 * action by Human + Device + Agent. Each NOVA install is a device with its
 * own Ed25519 key pair, created on first start and kept in
 * <DATA_DIR>/security/device.json (readable by this user only). The public
 * key is the device's identity; the private key signs approvals given here
 * and the evidence of every execution contract (lib/contracts.js).
 *
 * Devices belong to one of five classes. A class sets the most a device may
 * ever do (its authority); the capabilities a device declares say what it
 * is able to do. Neither is an authorization: policy and approval decide,
 * one contract at a time.
 *
 * Other devices (a paired phone, later an edge gateway or a robot) are kept
 * in the 'devices' store with their public key only. Pairing itself is
 * Phase 2; register() is the primitive it will use.
 * ========================================================================= */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE = 'devices';
const CLASSES = {
  interface:   { label: 'Interface',   examples: 'Web browser',              authority: ['request'] },
  companion:   { label: 'Companion',   examples: 'Phone, tablet',            authority: ['request', 'approve'] },
  workstation: { label: 'Workstation', examples: 'Mac, PC, Linux',           authority: ['request', 'approve', 'compute', 'execute'] },
  edge:        { label: 'Edge',        examples: 'Pi, Jetson, MCU gateway',  authority: ['sense', 'constrained-act'] },
  robot:       { label: 'Robot',       examples: 'AMR, arm, drone',          authority: ['physical-act'] },
};
/** Capabilities a device can declare. Desktop adds screen, input, clipboard and app control to the shared list. */
const CAPABILITIES = {
  'chat': 'Chat with NOVA',
  'camera.capture': 'Take photos or video',
  'microphone.capture': 'Record sound',
  'screen.capture': 'Take screenshots',
  'input.control': 'Move the mouse and type',
  'clipboard.read': 'Read the clipboard',
  'clipboard.write': 'Write the clipboard',
  'app.control': 'Open apps, files and websites',
  'file.read': 'Read files',
  'file.write': 'Change files',
  'repo.read': 'Read repositories',
  'repo.write': 'Change repositories',
  'browser.read': 'Read web pages',
  'browser.act': 'Act on web pages',
  'process.execute': 'Run programs and commands',
  'media.generate': 'Generate images, audio and video',
  'iot.read': 'Read sensors',
  'iot.control': 'Control connected devices',
  'robot.observe': 'Observe through a robot',
  'robot.navigate': 'Move a robot',
  'robot.manipulate': 'Handle objects with a robot',
};
/** What each class may declare at most. */
const CLASS_CAPABILITIES = {
  interface: ['chat', 'camera.capture', 'microphone.capture'],
  companion: ['chat', 'camera.capture', 'microphone.capture', 'file.read'],
  workstation: ['chat', 'camera.capture', 'microphone.capture', 'screen.capture', 'input.control', 'clipboard.read', 'clipboard.write', 'app.control', 'file.read', 'file.write', 'repo.read', 'repo.write', 'browser.read', 'browser.act', 'process.execute', 'media.generate'],
  edge: ['camera.capture', 'microphone.capture', 'iot.read', 'iot.control'],
  robot: ['camera.capture', 'microphone.capture', 'robot.observe', 'robot.navigate', 'robot.manipulate'],
};
const WORKSTATION_DEFAULT = ['chat', 'microphone.capture', 'screen.capture', 'input.control', 'clipboard.read', 'clipboard.write', 'app.control', 'file.read', 'file.write', 'repo.read', 'repo.write', 'browser.read', 'browser.act', 'process.execute', 'media.generate'];

function error(message, statusCode = 400, code) { return Object.assign(new Error(message), { statusCode, code }); }

/** JSON with sorted keys, so the same object always hashes and signs the same way. */
function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return 'dev_' + sha256(der).slice(0, 20);
}

const cache = new Map(); // dataDir -> { record, privateKey }
function keyFile(dataDir) {
  const dir = path.join(dataDir, 'security');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return path.join(dir, 'device.json');
}

/** This install's identity, created on first use. Returns the public record (never the private key). */
function load(dataDir) {
  if (cache.has(dataDir)) return cache.get(dataDir);
  const file = keyFile(dataDir);
  let saved = null;
  if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved || !saved.publicKey || !saved.privateKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    saved = { v: 1, algorithm: 'ed25519', createdAt: new Date().toISOString(), publicKey: pub, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600, flag: fs.existsSync(file) ? 'w' : 'wx' });
  }
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  const record = {
    id: fingerprint(saved.publicKey), class: 'workstation', name: os.hostname().replace(/\.local$/, ''),
    platform: process.platform, arch: process.arch, algorithm: 'ed25519', publicKey: saved.publicKey,
    capabilities: WORKSTATION_DEFAULT.slice(), authority: CLASSES.workstation.authority.slice(),
    status: 'this-device', createdAt: saved.createdAt,
  };
  const entry = { record, privateKey: crypto.createPrivateKey(saved.privateKey) };
  cache.set(dataDir, entry);
  return entry;
}
function self(dataDir) { return load(dataDir).record; }

/** Keeps this device's public record in the store, so contracts and the audit graph can resolve it. */
function ensure(store, dataDir) {
  const rec = self(dataDir);
  const old = store.get(STORE, rec.id);
  if (!old || old.publicKey !== rec.publicKey || old.name !== rec.name || canonical(old.capabilities) !== canonical(rec.capabilities)) store.put(STORE, { ...rec, firstSeenAt: old?.firstSeenAt || new Date().toISOString() });
  return rec;
}

function sign(dataDir, payload) { return crypto.sign(null, Buffer.from(typeof payload === 'string' ? payload : canonical(payload)), load(dataDir).privateKey).toString('base64'); }
function verify(publicKeyPem, payload, signature) {
  try { return crypto.verify(null, Buffer.from(typeof payload === 'string' ? payload : canonical(payload)), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature || ''), 'base64')); }
  catch (_) { return false; }
}

/** A device known to this workstation: itself or a registered one. */
function get(store, dataDir, id) {
  const me = self(dataDir);
  if (!id || id === me.id) return me;
  const d = store.get(STORE, id);
  if (!d) throw error('Unknown device.', 404, 'unknown_device');
  return d;
}
function can(device, authority) { return !!device && device.status !== 'revoked' && (CLASSES[device.class]?.authority || []).includes(authority); }

/** Records another device by its public key (the primitive pairing will use). Capabilities are limited by class. */
function register(store, dataDir, input = {}) {
  const cls = String(input.class || '');
  if (!CLASSES[cls]) throw error('Unknown device class. Use one of: ' + Object.keys(CLASSES).join(', ') + '.');
  let id; try { id = fingerprint(String(input.publicKey || '')); } catch (_) { throw error('A device needs an Ed25519 public key (PEM).'); }
  if (crypto.createPublicKey(input.publicKey).asymmetricKeyType !== 'ed25519') throw error('A device needs an Ed25519 public key (PEM).');
  if (id === self(dataDir).id) throw error('That is this device.', 409);
  const allowed = CLASS_CAPABILITIES[cls];
  const capabilities = [...new Set((Array.isArray(input.capabilities) ? input.capabilities : allowed).map(String))].filter(c => allowed.includes(c));
  const now = new Date().toISOString(), old = store.get(STORE, id);
  const rec = { id, class: cls, name: String(input.name || CLASSES[cls].label).slice(0, 80), platform: String(input.platform || '').slice(0, 40) || null, algorithm: 'ed25519', publicKey: crypto.createPublicKey(input.publicKey).export({ type: 'spki', format: 'pem' }), capabilities, authority: CLASSES[cls].authority.slice(), status: 'paired', human: input.human ? String(input.human).slice(0, 80) : null, createdAt: old?.createdAt || now, updatedAt: now };
  store.put(STORE, rec);
  return rec;
}
function revoke(store, dataDir, id) {
  if (id === self(dataDir).id) throw error('This device cannot revoke itself.', 409);
  const d = store.get(STORE, id); if (!d) throw error('Unknown device.', 404);
  const rec = { ...d, status: 'revoked', revokedAt: new Date().toISOString() };
  store.put(STORE, rec);
  return rec;
}
function list(store, dataDir) {
  const me = ensure(store, dataDir);
  return store.all(STORE).map(d => ({ ...d, self: d.id === me.id })).sort((a, b) => (b.self - a.self) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

module.exports = { STORE, CLASSES, CAPABILITIES, CLASS_CAPABILITIES, canonical, sha256, fingerprint, self, ensure, sign, verify, get, can, register, revoke, list, _reset: () => cache.clear() };
