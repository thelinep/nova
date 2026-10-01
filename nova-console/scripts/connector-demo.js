#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { openDb, Store } = require('../lib/db');
const { ConnectorRegistry } = require('../lib/connectors');
const { SecretVault } = require('../lib/secrets');
const { PolicyEngine } = require('../lib/policy');
const { GitHubConnector } = require('../lib/github-connector');
const { ConnectorActions } = require('../lib/connector-actions');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OPERATOR = process.env.NOVA_OPERATOR || 'demo-operator';
const USE_REAL = process.env.GITHUB_TOKEN ? true : false;
const REAL_TOKEN = process.env.GITHUB_TOKEN || null;
const REPO_OWNER = process.env.GITHUB_OWNER || 'demo-owner';
const REPO_NAME  = process.env.GITHUB_REPO  || 'demo-repo';
const HEAD_BRANCH = process.env.GITHUB_HEAD  || 'feature/demo';
const BASE_BRANCH = process.env.GITHUB_BASE  || 'main';

function startFakeGitHub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/user') {
      res.statusCode = 200;
      return res.end(JSON.stringify({ login: 'demo-user', id: 1 }));
    }
    const prMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (prMatch && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        res.statusCode = 201;
        res.end(JSON.stringify({
          number: 42,
          title: parsed.title,
          head: { ref: parsed.head },
          base: { ref: parsed.base },
          html_url: 'http://localhost:9999/demo-owner/demo-repo/pull/42',
          state: 'open',
        }));
      });
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found in fake' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, calls });
    });
  });
}

function banner(text) {
  console.log('\n== ' + text + ' ==');
}

async function main() {
  banner('NOVA connector demo');
  console.log('mode:       ' + (USE_REAL ? 'REAL github' : 'fake github (localhost)'));
  console.log('operator:   ' + OPERATOR);
  console.log('data dir:   ' + DATA_DIR);

  let fake = null;
  let apiBase = 'https://api.github.com';
  if (!USE_REAL) {
    fake = await startFakeGitHub();
    apiBase = 'http://127.0.0.1:' + fake.port;
    console.log('fake github: ' + apiBase);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { db } = openDb(DATA_DIR);
  const store = new Store(db);

  const registry = new ConnectorRegistry(store);
  const vault = new SecretVault(store, { dataDir: DATA_DIR });
  const policy = new PolicyEngine(store);

  // Clean up any previous demo profile
  const existing = registry.list({ kind: 'github' })
    .find((p) => p.name === 'demo-github');
  if (existing) {
    registry.revoke(existing.id);
    console.log('revoked previous demo-github profile ' + existing.id.slice(0, 12));
  }

  // Store the token as an encrypted secret
  const tokenValue = USE_REAL ? REAL_TOKEN : 'fake-token-abcdef';
  const secret = vault.put({
    name: 'demo-github-token',
    kind: 'github-token',
    value: tokenValue,
    createdBy: OPERATOR,
  });
  console.log('secret:     ' + secret.id + ' (plaintext never leaves the vault)');

  // Create the profile
  const profile = registry.create({
    kind: 'github',
    name: 'demo-github',
    config: { api_base_url: apiBase },
    scopes: ['repo:read', 'pr:read', 'pr:write'],
    createdBy: OPERATOR,
  });
  registry.attachSecret(profile.id, 'token', secret.id);
  console.log('profile:    ' + profile.id);

  // Grant a policy that requires approval before createPullRequest
  policy.grant({
    subject: { type: 'connector', id: profile.id },
    resource: { type: 'connector-action', id: 'createPullRequest' },
    effect: 'allow',
    conditions: { requires_approval: true },
  });
  console.log('policy:     granted createPullRequest (requires_approval)');

  // Wire the stack
  const github = new GitHubConnector({ registry, vault });
  const actions = new ConnectorActions({
    store,
    registry,
    connector: github,
    policy,
        audit: (e) => {
      console.log('  audit: ' + e.action + ' ' + JSON.stringify(
        Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'action'))
      ));
      try {
        store.auditAppend({
          id: 'lin_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          action: e.action,
          status: 'ok',
          operator: e.operator || 'system',
          timestamp: new Date().toISOString(),
          ...e,
        });
      } catch { /* best-effort */ }
    },
  });

  // Request a PR — should queue, not execute
  banner('1) request createPullRequest (policy requires approval)');
  const req = await actions.request(
    profile.id,
    'createPullRequest',
    [REPO_OWNER, REPO_NAME, {
      title: 'demo: add feature',
      head: HEAD_BRANCH,
      base: BASE_BRANCH,
      body: 'Created by NOVA connector demo.',
    }],
    OPERATOR
  );
  console.log('result:     ' + req.status);
  console.log('request_id: ' + (req.requestId || '(none)'));
  if (req.status !== 'pending') {
    console.error('expected pending, got ' + req.status);
    db.close();
    if (fake) fake.server.close();
    process.exit(1);
  }

  // Show the pending item in the workbench read model
  banner('2) workbench approvals queue sees it');
  const { Workbench } = require('../lib/workbench');
  const wb = new Workbench(store).snapshot();
  const hit = wb.approvals.items.find((i) => i.kind === 'connector_action');
  if (hit) {
    console.log('subject:    ' + hit.subject);
    console.log('title:      ' + hit.title);
    console.log('actions:    ' + hit.actions.join(', '));
  } else {
    console.log('(warning: connector_action not found in approvals)');
  }

  // Auto-approve the request and execute
  banner('3) approve and execute');
  const approved = await actions.approve(req.requestId, OPERATOR, 'demo auto-approve');
  console.log('status:     ' + approved.status);
  console.log('resolved_by:' + ' ' + approved.resolved_by);
  if (approved.result_json) {
    const result = JSON.parse(approved.result_json);
    console.log('result:     PR #' + result.number + ' ' + (result.html_url || ''));
  } else if (approved.error) {
    console.log('error:      ' + approved.error);
  }

  // Show the fake GitHub received the call
  if (fake) {
    banner('4) fake github received');
    for (const c of fake.calls) {
      console.log('  ' + c.method + ' ' + c.url);
    }
  }

  // Print SQLite audit
  banner('5) sqlite audit');
  const reqs = store.connectorActionRequestsList({});
  console.log('connector action requests: ' + reqs.length);
  for (const r of reqs) {
    console.log('  ' + r.id.slice(0, 12) + '  status=' + r.status
      + '  op=' + r.operation
      + '  by=' + r.requested_by
      + '  resolved_by=' + (r.resolved_by || '-'));
  }
  const lineage = store.autonomyLineageList({});
  const caEvents = lineage.filter((l) => {
    try { return (JSON.parse(l.payload_json).action || '').startsWith('connector_action'); }
    catch { return false; }
  });
  console.log('autonomy lineage entries for connector_action: ' + caEvents.length);

  db.close();
  if (fake) fake.server.close();

  banner('done');
  console.log('Open http://127.0.0.1:7777/workbench.html to see the same request in the UI');
  console.log('(the DB persists in ' + DATA_DIR + ')');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('demo failed:', e);
    process.exit(1);
  });
}

module.exports = { main };
