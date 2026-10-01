'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, Store } = require('../lib/db');
const { ConnectorRegistry, ConnectorError } = require('../lib/connectors');
const { SecretVault, SecretError } = require('../lib/secrets');
const { GitHubConnector, GitHubError } = require('../lib/github-connector');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ghc-'));
  const { db } = openDb(dir);
  const store = new Store(db);
  return { dir, db, store };
}
function cleanup(env) {
  try { env.db.close(); } catch {}
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

function setup(opts) {
  opts = opts || {};
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const vault = new SecretVault(env.store, { dataDir: env.dir });

  const secret = vault.put({ name: 'gh-token', kind: 'github-token', value: opts.token || 'ghp_secret' });

  const profile = registry.create({
    kind: 'github',
    name: 'test-gh',
    config: { api_base_url: opts.apiBase || 'https://api.github.com' },
    scopes: opts.scopes || ['repo:read', 'issue:read', 'issue:write', 'pr:read', 'pr:write', 'pr:merge', 'ci:read'],
  });
  registry.attachSecret(profile.id, 'token', secret.id);

  const calls = [];
  const responses = opts.responses || [];
  let callIndex = 0;

  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[callIndex++] || {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    };
    return r;
  };

  const events = [];
  const gh = new GitHubConnector({
    registry,
    vault,
    fetch: fakeFetch,
    audit: (e) => events.push(e),
  });

  return { env, registry, vault, gh, secret, profile, calls, events, setResponses: (r) => { responses.length = 0; r.forEach((x) => responses.push(x)); } };
}

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('1 whoami_returns_user', async () => {
  const s = setup({ responses: [res(200, { login: 'octocat' })] });
  const me = await s.gh.whoami(s.profile.id);
  assert.equal(me.login, 'octocat');
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].url, /\/user$/);
  cleanup(s.env);
});

test('2 token_is_injected_but_never_returned', async () => {
  const s = setup({ token: 'ghp_super_secret', responses: [res(200, { login: 'x' })] });
  const me = await s.gh.whoami(s.profile.id);
  assert.equal(me.login, 'x');
  const authHeader = s.calls[0].init.headers.Authorization;
  assert.equal(authHeader, 'Bearer ghp_super_secret');
  // The plaintext token must not be present anywhere in the returned object
  assert.ok(!JSON.stringify(me).includes('ghp_super_secret'));
  cleanup(s.env);
});

test('3 missing_profile', async () => {
  const s = setup({ responses: [res(200, {})] });
  await assert.rejects(
    () => s.gh.whoami('nope'),
    (e) => e instanceof GitHubError && e.code === 'not_found'
  );
  cleanup(s.env);
});

test('4 inactive_profile_rejected', async () => {
  const s = setup({ responses: [res(200, {})] });
  s.registry.disable(s.profile.id);
  await assert.rejects(
    () => s.gh.whoami(s.profile.id),
    (e) => e.code === 'inactive'
  );
  cleanup(s.env);
});

test('5 wrong_kind_rejected', async () => {
  const s = setup({ responses: [res(200, {})] });
  const slack = s.registry.create({ kind: 'slack', name: 'x', scopes: [] });
  await assert.rejects(
    () => s.gh.whoami(slack.id),
    (e) => e.code === 'wrong_kind'
  );
  cleanup(s.env);
});

test('6 missing_scope_blocks_call', async () => {
  const s = setup({ responses: [res(200, {})], scopes: ['repo:read'] });
  await assert.rejects(
    () => s.gh.createIssue(s.profile.id, 'o', 'r', { title: 'x' }),
    (e) => e.code === 'missing_scope'
  );
  // No fetch call was made
  assert.equal(s.calls.length, 0);
  cleanup(s.env);
});

test('7 http_401_raises_http_error', async () => {
  const s = setup({ responses: [res(401, { message: 'Bad credentials' })] });
  await assert.rejects(
    () => s.gh.whoami(s.profile.id),
    (e) => e instanceof GitHubError && e.code === 'http_error' && e.status === 401
  );
  cleanup(s.env);
});

test('8 network_error_wrapped', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const vault = new SecretVault(env.store, { dataDir: env.dir });
  const secret = vault.put({ name: 't', kind: 'github-token', value: 'x' });
  const profile = registry.create({ kind: 'github', name: 'g', scopes: [] });
  registry.attachSecret(profile.id, 'token', secret.id);

  const gh = new GitHubConnector({
    registry, vault,
    fetch: async () => { throw new Error('ENOTFOUND'); },
  });

  await assert.rejects(
    () => gh.whoami(profile.id),
    (e) => e.code === 'network_error'
  );
  cleanup(env);
});

test('9 create_issue_posts_correct_body', async () => {
  const s = setup({ responses: [res(201, { number: 42, title: 'bug' })] });
  const out = await s.gh.createIssue(s.profile.id, 'octocat', 'hello-world', {
    title: 'bug', body: 'see attached', labels: ['triage'],
  });
  assert.equal(out.number, 42);
  const call = s.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.match(call.url, /\/repos\/octocat\/hello-world\/issues$/);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.title, 'bug');
  assert.equal(sent.body, 'see attached');
  assert.deepEqual(sent.labels, ['triage']);
  cleanup(s.env);
});

test('10 create_pr_requires_head_and_base', async () => {
  const s = setup({ responses: [res(201, { number: 7 })] });
  await assert.rejects(
    () => s.gh.createPullRequest(s.profile.id, 'o', 'r', { title: 'x' }),
    (e) => e.code === 'bad_args'
  );
  const out = await s.gh.createPullRequest(s.profile.id, 'o', 'r', {
    title: 'x', head: 'feature', base: 'main',
  });
  assert.equal(out.number, 7);
  const sent = JSON.parse(s.calls[0].init.body);
  assert.equal(sent.head, 'feature');
  assert.equal(sent.base, 'main');
  cleanup(s.env);
});

test('11 custom_api_base_url_used', async () => {
  const s = setup({
    apiBase: 'https://github.example.com/api/v3',
    responses: [res(200, { login: 'x' })],
  });
  await s.gh.whoami(s.profile.id);
  assert.match(s.calls[0].url, /^https:\/\/github\.example\.com\/api\/v3\/user$/);
  cleanup(s.env);
});

test('12 audit_events_written', async () => {
  const s = setup({ responses: [res(200, { login: 'x' }), res(201, { number: 1 })] });
  await s.gh.whoami(s.profile.id);
  await s.gh.createIssue(s.profile.id, 'o', 'r', { title: 't' });
  const actions = s.events.map((e) => e.action);
  assert.ok(actions.includes('github.whoami'));
  assert.ok(actions.includes('github.createIssue'));
  cleanup(s.env);
});

test('13 no_secret_attached_rejected', async () => {
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  const vault = new SecretVault(env.store, { dataDir: env.dir });
  const profile = registry.create({
    kind: 'github', name: 'g', scopes: ['repo:read'],
  });
  const gh = new GitHubConnector({
    registry, vault, fetch: async () => res(200, {}),
  });
  await assert.rejects(
    () => gh.whoami(profile.id),
    (e) => e.code === 'no_secret'
  );
  cleanup(env);
});

test('14 revoke_profile_blocks_calls', async () => {
  const s = setup({ responses: [res(200, { login: 'x' })] });
  s.registry.revoke(s.profile.id);
  await assert.rejects(
    () => s.gh.whoami(s.profile.id),
    (e) => e.code === 'inactive'
  );
  cleanup(s.env);
});

test('15 constructor_and_args_validation', () => {
  assert.throws(() => new GitHubConnector({}), (e) => e.code === 'bad_registry');
  const env = fresh();
  const registry = new ConnectorRegistry(env.store);
  assert.throws(() => new GitHubConnector({ registry }), (e) => e.code === 'bad_vault');
  const vault = new SecretVault(env.store, { dataDir: env.dir });
  assert.throws(() => new GitHubConnector({ registry, vault, fetch: 'not-a-fn' }),
    (e) => e.code === 'bad_fetch');
  cleanup(env);
});
