'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const KEY_FILE = '.secret-master-key';

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

class SecretError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecretError';
    this.code = code || 'secret_error';
  }
}

class SecretNotFoundError extends SecretError {
  constructor() { super('secret not found', 'not_found'); }
}
class SecretRevokedError extends SecretError {
  constructor() { super('secret revoked', 'revoked'); }
}
class SecretDecryptError extends SecretError {
  constructor() { super('decryption failed', 'decrypt_failed'); }
}

function loadMasterKey(dataDir) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new SecretError('dataDir required', 'bad_data_dir');
  }
  const p = path.join(dataDir, KEY_FILE);
  if (fs.existsSync(p)) {
    const key = fs.readFileSync(p);
    if (key.length !== KEY_LEN) {
      throw new SecretError('master key has wrong length', 'bad_key');
    }
    return key;
  }
  const key = crypto.randomBytes(KEY_LEN);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, key, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
  return key;
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext_b64: ct.toString('base64'),
    iv_b64: iv.toString('base64'),
    tag_b64: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(key, row) {
  const iv = Buffer.from(row.iv_b64, 'base64');
  const tag = Buffer.from(row.tag_b64, 'base64');
  const ct = Buffer.from(row.ciphertext_b64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function metadataOnly(row) {
  if (!row) return null;
  let meta = null;
  try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch { meta = null; }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    metadata: meta,
    created_at: row.created_at,
    created_by: row.created_by,
    rotated_at: row.rotated_at || null,
    revoked_at: row.revoked_at || null,
    active: !row.revoked_at,
  };
}

/**
 * SecretVault stores encrypted values at rest.
 *
 * Public reads (get, list, metadata) return metadata only.
 * The only way to touch a plaintext value is `use(id, fn)`, which
 * decrypts in memory, invokes fn(value), and discards. The plaintext
 * is never returned to the caller or logged.
 *
 * Audit is written on put, rotate, revoke, and each use.
 */
class SecretVault {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new SecretError('store required', 'bad_store');
    if (!options.dataDir) throw new SecretError('dataDir required', 'bad_data_dir');
    this.store = store;
    this.dataDir = options.dataDir;
    this.audit = typeof options.audit === 'function' ? options.audit : null;
    this.key = loadMasterKey(this.dataDir);
  }

  put(input) {
    input = input || {};
    if (!input.name || typeof input.name !== 'string') {
      throw new SecretError('name required', 'bad_name');
    }
    if (!input.kind || typeof input.kind !== 'string') {
      throw new SecretError('kind required', 'bad_kind');
    }
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new SecretError('value required', 'bad_value');
    }
    const blob = encrypt(this.key, input.value);
    const row = this.store.secretRecordsInsert({
      id: input.id || uid('sec'),
      name: input.name.trim(),
      kind: input.kind,
      ciphertext_b64: blob.ciphertext_b64,
      iv_b64: blob.iv_b64,
      tag_b64: blob.tag_b64,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
      rotated_at: null,
      revoked_at: null,
    });
    this._audit('secret.created', { secret_id: row.id, name: row.name, kind: row.kind }, input.createdBy);
    return metadataOnly(row);
  }

  get(id) {
    if (!id) throw new SecretError('id required', 'bad_id');
    const row = this.store.secretRecordsGet(id);
    if (!row) throw new SecretNotFoundError();
    return metadataOnly(row);
  }

  list(filter) {
    return this.store.secretRecordsList(filter || {}).map(metadataOnly);
  }

  metadata(id) { return this.get(id); }

  count(filter) {
    return this.store.secretRecordsList(filter || {}).length;
  }

  revoke(id, operator) {
    const row = this.store.secretRecordsGet(id);
    if (!row) throw new SecretNotFoundError();
    if (row.revoked_at) return metadataOnly(row);
    const updated = this.store.secretRecordsUpdate(id, { revoked_at: nowIso() });
    this._audit('secret.revoked', { secret_id: id, name: row.name }, operator);
    return metadataOnly(updated);
  }

  rotate(id, newValue, operator) {
    if (typeof newValue !== 'string' || newValue.length === 0) {
      throw new SecretError('value required', 'bad_value');
    }
    const row = this.store.secretRecordsGet(id);
    if (!row) throw new SecretNotFoundError();
    if (row.revoked_at) throw new SecretRevokedError();
    const blob = encrypt(this.key, newValue);
    const updated = this.store.secretRecordsUpdate(id, {
      ciphertext_b64: blob.ciphertext_b64,
      iv_b64: blob.iv_b64,
      tag_b64: blob.tag_b64,
      rotated_at: nowIso(),
    });
    this._audit('secret.rotated', { secret_id: id, name: row.name }, operator);
    return metadataOnly(updated);
  }

  /**
   * Decrypt and pass the plaintext to fn. Never returns the value.
   * Writes a use-audit event regardless of success or failure.
   */
  async use(id, fn, operator) {
    if (typeof fn !== 'function') {
      throw new SecretError('fn must be a function', 'bad_fn');
    }
    const row = this.store.secretRecordsGet(id);
    if (!row) throw new SecretNotFoundError();
    if (row.revoked_at) throw new SecretRevokedError();
    let plaintext;
    try {
      plaintext = decrypt(this.key, row);
    } catch {
      this._audit('secret.use_failed', { secret_id: id, name: row.name, reason: 'decrypt_failed' }, operator);
      throw new SecretDecryptError();
    }
    try {
      const result = await fn(plaintext);
      this._audit('secret.used', { secret_id: id, name: row.name, kind: row.kind }, operator);
      return result;
    } catch (e) {
      this._audit('secret.use_failed', { secret_id: id, name: row.name, reason: String(e && e.message || e) }, operator);
      throw e;
    } finally {
      plaintext = null;
    }
  }

  _audit(action, data, operator) {
    if (!this.audit) return;
    try {
      this.audit({ action, operator: operator || 'system', ...data });
    } catch { /* best-effort */ }
  }
}

module.exports = { SecretVault, SecretError, SecretNotFoundError, SecretRevokedError, SecretDecryptError, loadMasterKey };
