'use strict';
/* ===========================================================================
 * Resume passphrase for the kill switch
 *
 * Halting NOVA is always allowed; resuming needs a credential so an agent
 * that halted things cannot quietly undo it. The credential can come from the
 * NOVA_RESUME_CREDENTIAL environment variable (servers) or from a passphrase
 * set in Workbench (the desktop app, which has no environment to set). The
 * passphrase is kept only as a salted scrypt hash in the data folder.
 * ========================================================================= */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE = '.resume-passphrase';
const MIN_LENGTH = 6;

function error(message, statusCode = 400, code) { return Object.assign(new Error(message), { statusCode, code }); }
function file(dataDir) { return path.join(dataDir, FILE); }

function hash(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32).toString('hex');
}

function read(dataDir) {
  try {
    const [salt, digest] = fs.readFileSync(file(dataDir), 'utf8').trim().split(':');
    return salt && digest ? { salt, digest } : null;
  } catch (_) { return null; }
}

function fromEnv() { return Boolean(process.env.NOVA_RESUME_CREDENTIAL); }

function status(dataDir) {
  return { set: Boolean(read(dataDir)) || fromEnv(), source: fromEnv() ? 'environment' : read(dataDir) ? 'passphrase' : null };
}

function verify(dataDir, credential) {
  if (typeof credential !== 'string' || !credential) return false;
  const expected = process.env.NOVA_RESUME_CREDENTIAL;
  if (expected) {
    const a = Buffer.from(credential), b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const stored = read(dataDir);
  if (!stored) return false;
  const a = Buffer.from(hash(credential, stored.salt), 'hex'), b = Buffer.from(stored.digest, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Sets or changes the passphrase. Changing one needs the current passphrase. */
function set(dataDir, { passphrase, current } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_LENGTH) throw error(`Use at least ${MIN_LENGTH} characters.`, 400, 'bad_passphrase');
  if (read(dataDir) && !verify(dataDir, current)) throw error('The current passphrase is not right.', 403, 'auth_failed');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), `${salt}:${hash(passphrase, salt)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file(dataDir), 0o600); } catch (_) {}
  return status(dataDir);
}

module.exports = { status, verify, set, MIN_LENGTH, FILE };
