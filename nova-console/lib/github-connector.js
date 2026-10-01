'use strict';

const nowIso = () => new Date().toISOString();

const DEFAULT_API = 'https://api.github.com';

class GitHubError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GitHubError';
    this.code = code || 'github_error';
    this.status = status || null;
  }
}

const REQUIRED_SCOPES = {
  whoami:              [],
  getRepo:             ['repo:read'],
  listIssues:          ['repo:read', 'issue:read'],
  createIssue:         ['issue:write'],
  getPullRequest:      ['repo:read', 'pr:read'],
  createPullRequest:   ['pr:write'],
  listChecks:          ['repo:read', 'ci:read'],
  mergePullRequest:    ['pr:write', 'pr:merge'],
};

/**
 * GitHub connector.
 *
 * Construction takes a registry, a vault, and an injected fetch
 * function (default: global fetch). The connector resolves a named
 * profile, resolves the secret name to an id, and calls
 * vault.use(id, fn) to inject the token. The token never leaves
 * the closure.
 *
 * Scope checks are enforced before every network call.
 */
class GitHubConnector {
  constructor(deps) {
    deps = deps || {};
    if (!deps.registry) throw new GitHubError('registry required', 'bad_registry');
    if (!deps.vault) throw new GitHubError('vault required', 'bad_vault');
    this.registry = deps.registry;
    this.vault = deps.vault;
    this.fetch = deps.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new GitHubError('fetch function required', 'bad_fetch');
    }
    this.audit = typeof deps.audit === 'function' ? deps.audit : null;
    this.defaultSecretName = deps.secretName || 'token';
    this.apiBase = deps.apiBase || null; // override comes from profile.config
  }

  _profile(profileId) {
    const profile = this.registry.get(profileId);
    if (!profile) throw new GitHubError('profile not found', 'not_found');
    if (profile.kind !== 'github') throw new GitHubError('profile is not a github connector', 'wrong_kind');
    if (!this.registry.isActive(profileId)) throw new GitHubError('profile not active', 'inactive');
    return profile;
  }

  _checkScopes(profileId, opName) {
    const required = REQUIRED_SCOPES[opName] || [];
    for (const s of required) {
      if (!this.registry.hasScope(profileId, s)) {
        throw new GitHubError(
          'missing scope ' + s + ' for ' + opName,
          'missing_scope'
        );
      }
    }
  }

  _baseUrl(profileId) {
    if (this.apiBase) return this.apiBase;
    const cfg = this.registry.config(profileId);
    if (cfg && typeof cfg.api_base_url === 'string' && cfg.api_base_url) {
      return cfg.api_base_url.replace(/\/+$/, '');
    }
    return DEFAULT_API;
  }

  _secretId(profileId) {
    const id = this.registry.secretRef(profileId, this.defaultSecretName);
    if (!id) throw new GitHubError('no secret attached to profile', 'no_secret');
    return id;
  }

  async _request(profileId, method, path, body, opName) {
    this._profile(profileId);   
    this._checkScopes(profileId, opName);
    const secretId = this._secretId(profileId);
    const base = this._baseUrl(profileId);

    return this.vault.use(secretId, async (token) => {
      const url = path.startsWith('http') ? path : base + path;
      const headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const init = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await this.fetch(url, init);
      } catch (e) {
        const err = new GitHubError('network error: ' + (e.message || e), 'network_error');
        this._audit('github.' + opName, { profile_id: profileId, path, error: err.code });
        throw err;
      }

      let payload = null;
      const text = await response.text();
      if (text) {
        try { payload = JSON.parse(text); }
        catch { payload = { raw: text }; }
      }

      const status = response.status;
      const ok = response.ok === true || (status >= 200 && status < 300);

      this._audit('github.' + opName, {
        profile_id: profileId,
        method,
        path,
        status,
        ok,
      });

      if (!ok) {
        const msg = (payload && (payload.message || payload.error)) || ('HTTP ' + status);
        throw new GitHubError(msg, 'http_error', status);
      }

      return payload;
    });
  }

  // ---- Operations ----

  async whoami(profileId) {
    return this._request(profileId, 'GET', '/user', undefined, 'whoami');
  }

  async getRepo(profileId, owner, repo) {
    if (!owner || !repo) throw new GitHubError('owner and repo required', 'bad_args');
    return this._request(profileId, 'GET', '/repos/' + owner + '/' + repo, undefined, 'getRepo');
  }

  async listIssues(profileId, owner, repo, options) {
    if (!owner || !repo) throw new GitHubError('owner and repo required', 'bad_args');
    const q = new URLSearchParams();
    if (options && options.state) q.set('state', options.state);
    if (options && options.limit) q.set('per_page', String(Math.min(options.limit, 100)));
    const path = '/repos/' + owner + '/' + repo + '/issues' + (q.toString() ? '?' + q.toString() : '');
    return this._request(profileId, 'GET', path, undefined, 'listIssues');
  }

  async createIssue(profileId, owner, repo, input) {
    if (!owner || !repo) throw new GitHubError('owner and repo required', 'bad_args');
    if (!input || !input.title) throw new GitHubError('title required', 'bad_args');
    return this._request(profileId, 'POST', '/repos/' + owner + '/' + repo + '/issues', {
      title: input.title,
      body: input.body || '',
      labels: input.labels || undefined,
    }, 'createIssue');
  }

  async getPullRequest(profileId, owner, repo, number) {
    if (!owner || !repo || !number) throw new GitHubError('owner, repo, number required', 'bad_args');
    return this._request(profileId, 'GET',
      '/repos/' + owner + '/' + repo + '/pulls/' + number, undefined, 'getPullRequest');
  }

  async createPullRequest(profileId, owner, repo, input) {
    if (!owner || !repo) throw new GitHubError('owner and repo required', 'bad_args');
    if (!input || !input.title || !input.head || !input.base) {
      throw new GitHubError('title, head, base required', 'bad_args');
    }
    return this._request(profileId, 'POST', '/repos/' + owner + '/' + repo + '/pulls', {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body || '',
      draft: input.draft === true,
    }, 'createPullRequest');
  }

  async listChecks(profileId, owner, repo, ref) {
    if (!owner || !repo || !ref) throw new GitHubError('owner, repo, ref required', 'bad_args');
    return this._request(profileId, 'GET',
      '/repos/' + owner + '/' + repo + '/commits/' + ref + '/check-runs', undefined, 'listChecks');
  }

  async mergePullRequest(profileId, owner, repo, number, options) {
    if (!owner || !repo || !number) throw new GitHubError('owner, repo, number required', 'bad_args');
    return this._request(profileId, 'PUT',
      '/repos/' + owner + '/' + repo + '/pulls/' + number + '/merge', {
        merge_method: (options && options.method) || 'squash',
        commit_title: options && options.title,
        commit_message: options && options.message,
      }, 'mergePullRequest');
  }

  _audit(action, data) {
    if (!this.audit) return;
    try { this.audit({ action, ...data }); }
    catch { /* best-effort */ }
  }
}

module.exports = { GitHubConnector, GitHubError, REQUIRED_SCOPES };
