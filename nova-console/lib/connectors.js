'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

const KNOWN_KINDS = [
  'github', 'slack', 'google-drive', 'notion',
  'linear', 'email', 'calendar', 'custom',
];

class ConnectorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code || 'connector_error';
  }
}

/**
 * Connector registry.
 *
 * A connector profile is a named configuration for connecting to an
 * external service. It holds non-secret configuration and a map of
 * secret *references* (name -> secret_record_id). The actual secrets
 * are stored by lib/secrets.js and are never visible here.
 *
 * Scopes are declared per profile and checked before any action.
 * Revocation is soft: revoked_at is set, but the row is preserved
 * for audit.
 */
class ConnectorRegistry {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new ConnectorError('store required', 'bad_store');
    this.store = store;
    this.allowedKinds = Array.isArray(options.allowedKinds)
      ? options.allowedKinds.slice()
      : KNOWN_KINDS.slice();
  }

  create(input) {
    input = input || {};
    if (!input.kind || typeof input.kind !== 'string') {
      throw new ConnectorError('kind required', 'bad_kind');
    }
    if (!this.allowedKinds.includes(input.kind)) {
      throw new ConnectorError('unknown kind: ' + input.kind, 'unknown_kind');
    }
    if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
      throw new ConnectorError('name required', 'bad_name');
    }
    if (this.store.connectorProfilesFindByName(input.kind, input.name)) {
      throw new ConnectorError('profile name already exists for this kind', 'duplicate_name');
    }
    if (input.config != null && typeof input.config !== 'object') {
      throw new ConnectorError('config must be an object', 'bad_config');
    }
    if (input.scopes != null && !Array.isArray(input.scopes)) {
      throw new ConnectorError('scopes must be an array', 'bad_scopes');
    }
    const scopes = (input.scopes || []).map(String);
    for (const s of scopes) {
      if (!/^[a-z0-9:_-]+$/i.test(s)) {
        throw new ConnectorError('invalid scope: ' + s, 'bad_scope');
      }
    }

    return this.store.connectorProfilesInsert({
      id: input.id || uid('conn'),
      kind: input.kind,
      name: input.name.trim(),
      config_json: JSON.stringify(input.config || {}),
      secret_refs_json: JSON.stringify({}),
      scopes_json: JSON.stringify(scopes),
      enabled: input.enabled !== false,
      created_at: nowIso(),
      created_by: input.createdBy || 'system',
      revoked_at: null,
    });
  }

  get(id) {
    if (!id) throw new ConnectorError('id required', 'bad_id');
    return this.store.connectorProfilesGet(id);
  }

  list(filter) {
    return this.store.connectorProfilesList(filter || {});
  }

  enable(id) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    if (cur.revoked_at) throw new ConnectorError('profile revoked', 'revoked');
    return this.store.connectorProfilesUpdate(id, { enabled: 1 });
  }

  disable(id) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    return this.store.connectorProfilesUpdate(id, { enabled: 0 });
  }

  revoke(id) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    if (cur.revoked_at) return cur;
    return this.store.connectorProfilesUpdate(id, { revoked_at: nowIso(), enabled: 0 });
  }

  updateConfig(id, config) {
    if (!config || typeof config !== 'object') {
      throw new ConnectorError('config must be an object', 'bad_config');
    }
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    if (cur.revoked_at) throw new ConnectorError('profile revoked', 'revoked');
    return this.store.connectorProfilesUpdate(id, {
      config_json: JSON.stringify(config),
    });
  }

  setScopes(id, scopes) {
    if (!Array.isArray(scopes)) throw new ConnectorError('scopes must be an array', 'bad_scopes');
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    if (cur.revoked_at) throw new ConnectorError('profile revoked', 'revoked');
    return this.store.connectorProfilesUpdate(id, {
      scopes_json: JSON.stringify(scopes.map(String)),
    });
  }

  attachSecret(id, secretName, secretRecordId) {
    if (!secretName || typeof secretName !== 'string') {
      throw new ConnectorError('secretName required', 'bad_secret_name');
    }
    if (!secretRecordId || typeof secretRecordId !== 'string') {
      throw new ConnectorError('secretRecordId required', 'bad_secret_id');
    }
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    if (cur.revoked_at) throw new ConnectorError('profile revoked', 'revoked');
    let refs = {};
    try { refs = JSON.parse(cur.secret_refs_json || '{}'); } catch { refs = {}; }
    refs[secretName] = secretRecordId;
    return this.store.connectorProfilesUpdate(id, {
      secret_refs_json: JSON.stringify(refs),
    });
  }

  secretRef(id, secretName) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    let refs = {};
    try { refs = JSON.parse(cur.secret_refs_json || '{}'); } catch { refs = {}; }
    return refs[secretName] || null;
  }

  scopes(id) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    try { return JSON.parse(cur.scopes_json || '[]'); }
    catch { return []; }
  }

  hasScope(id, scope) {
    if (!scope) return false;
    return this.scopes(id).includes(scope);
  }

  config(id) {
    const cur = this.get(id);
    if (!cur) throw new ConnectorError('profile not found', 'not_found');
    try { return JSON.parse(cur.config_json || '{}'); }
    catch { return {}; }
  }

  isActive(id) {
    const cur = this.get(id);
    if (!cur) return false;
    return !cur.revoked_at && cur.enabled === 1;
  }

  health() {
    const all = this.list({ active: true });
    const byKind = {};
    for (const p of all) {
      byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    }
    return {
      total: all.length,
      enabled: all.filter((p) => p.enabled === 1).length,
      disabled: all.filter((p) => p.enabled === 0).length,
      by_kind: byKind,
    };
  }
}

module.exports = { ConnectorRegistry, ConnectorError, KNOWN_KINDS };
