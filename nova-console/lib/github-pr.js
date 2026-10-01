'use strict';

const { execFileSync } = require('node:child_process');
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function executePullRequest(store, scanner, security, dataDir, actionId, connectorId) {
  const action = store.get('workspaceGitActions', String(actionId));
  if (!action || action.type !== 'pull-request-draft') throw error('Unknown pull-request draft.', 404);
  if (action.status !== 'reviewed' || !action.review) throw error('Review the unchanged branch and successful test evidence before creating a pull request.', 409);
  const connector = store.get('connectorProfiles', String(connectorId));
  if (!connector || connector.provider !== 'github' || !connector.secretId) throw error('A configured GitHub connector with an encrypted token is required.', 409);
  const root = scanner.approvedRoot(store, action.rootId);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root.path, encoding: 'utf8' }).trim();
  if (head !== action.review.headSha) throw error('HEAD changed after pull-request review.', 409);
  const token = security.getSecret(store, dataDir, connector.secretId);
  let url;
  try { url = execFileSync('gh', ['pr', 'create', '--base', action.base, '--head', action.head, '--title', action.title, '--body', action.body], { cwd: root.path, encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (cause) { throw error(String(cause.stderr || cause.message).trim().slice(0, 2000), 502); }
  action.status = 'created'; action.delivery = { provider: 'github', connectorId: connector.id, url, createdAt: new Date().toISOString(), reviewedHeadSha: action.review.headSha }; store.put('workspaceGitActions', action); return action;
}

function refreshChecks(store, security, dataDir, actionId, connectorId) {
  const action = store.get('workspaceGitActions', String(actionId));
  if (!action?.delivery?.url || action.delivery.provider !== 'github') throw error('Create the GitHub pull request before checking CI.', 409);
  const connector = store.get('connectorProfiles', String(connectorId));
  if (!connector || connector.provider !== 'github' || !connector.secretId) throw error('A configured GitHub connector with an encrypted token is required.', 409);
  const token = security.getSecret(store, dataDir, connector.secretId);
  let checks;
  try { checks = JSON.parse(execFileSync('gh', ['pr', 'checks', action.delivery.url, '--json', 'name,state,link'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (cause) { throw error(String(cause.stderr || cause.message).trim().slice(0, 2000), 502); }
  const states = checks.map(check => String(check.state).toUpperCase());
  action.ci = { checkedAt: new Date().toISOString(), connectorId: connector.id, checks, status: states.length && states.every(state => state === 'SUCCESS') ? 'passed' : (states.some(state => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(state)) ? 'failed' : 'pending') };
  store.put('workspaceGitActions', action); return action;
}

module.exports = { executePullRequest, refreshChecks };
