'use strict';
/* ===========================================================================
 * Maataa App Builder — "describe an app, get a working, tested project"
 *
 * It joins pieces Maataa already has, without adding a new write path:
 *   1. draft    pick a template from the description, choose a free folder
 *               name, draft the project (workspace-projects.draftProject) and
 *               compose a specific coding request. Nothing touches disk.
 *   2. start    on your click: create the project from the template (git init,
 *               approved as its own root), allow the template's own test/dev/
 *               build commands for that new repository only, then run the
 *               development loop (plan → apply to a copy → npm test → retry
 *               with the test output, up to 5 attempts) with the model you
 *               chose. Model qualification is enforced by the planner.
 *   3. review   when tests pass the loop leaves a checked change batch. You
 *               approve and apply it through the normal batch endpoints;
 *               nothing is written to the new project before that.
 * Records live in the 'appBuilds' store. The default parent folder is
 * ~/Maataa Projects (NOVA_PROJECTS_DIR overrides it) and is only created and
 * approved when you ask for it.
 * ========================================================================= */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE = 'appBuilds';
const MAX_DESCRIPTION = 2000;
const COMMANDS = ['test', 'dev', 'build', 'git-status'];

/** Per template: the files the model should shape and the tests that must keep passing. */
const RECIPES = {
  'static-site': {
    files: ['index.html', 'styles.css', 'main.js', 'test/site.test.js'],
    request: d => `Update index.html, styles.css and main.js so that the page becomes this app: ${d}\n` +
      'Put all behaviour in main.js and all styling in styles.css. Keep the <title>, and link only to files that exist, so that test/site.test.js passes. ' +
      'Also update test/site.test.js with at least one more test that checks the main element of this app exists in index.html.',
  },
  'node-api': {
    files: ['src/app.js', 'test/app.test.js'],
    request: d => `Update src/app.js and test/app.test.js so that the JSON API implements: ${d}\n` +
      'Keep GET /health returning {"ok":true}. Use only Node built-in modules. Add tests in test/app.test.js for every new route so that npm test passes.',
  },
  'vite-react': {
    files: ['src/App.jsx', 'src/greeting.js', 'src/styles.css', 'test/greeting.test.js'],
    request: d => `Update src/App.jsx, src/styles.css and src/greeting.js so that the React app becomes: ${d}\n` +
      'Keep pure logic in src/greeting.js (or new plain .js modules in src/) and cover it in test/greeting.test.js so that npm test passes without installing packages.',
  },
};

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function now() { return new Date().toISOString(); }

/** Picks a template from words in the description (English or Hindi). */
function suggestTemplate(description) {
  const text = String(description || '').toLowerCase();
  if (/\breact\b|रिएक्ट/.test(text)) return 'vite-react';
  if (/\b(api|rest|json|endpoint|backend|server|crud|webhook)\b|एपीआई|सर्वर|बैकएंड/.test(text)) return 'node-api';
  return 'static-site';
}

/** A folder name: ASCII words from the description, else app-<date>. */
function suggestName(description, taken = () => false) {
  const words = String(description || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9]+/g) || [];
  const stop = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'with', 'that', 'which', 'in', 'on', 'my', 'me', 'app', 'make', 'build', 'create', 'simple', 'please', 'website', 'page', 'site']);
  const picked = words.filter(w => !stop.has(w)).slice(0, 4);
  let base = picked.join('-').slice(0, 40).replace(/-+$/, '');
  if (!base || !/^[a-z0-9]/.test(base)) base = 'app-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let name = base, n = 2;
  while (taken(name)) name = `${base}-${n++}`;
  return name;
}

function titleFrom(name) {
  return name.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 80) || 'New App';
}

function defaultProjectsDir() {
  return process.env.NOVA_PROJECTS_DIR || path.join(os.homedir(), 'Maataa Projects');
}

/** Creates ~/Maataa Projects if needed and approves it as a root (explicit user action). */
function ensureProjectsRoot(store, scanner) {
  const dir = defaultProjectsDir();
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync.native(dir);
  const existing = store.all('workspaceRoots').find(root => root.path === real);
  return existing || scanner.approveRoot(store, { path: dir, label: 'Maataa Projects' });
}

function composeRequest(template, description) {
  const recipe = RECIPES[template];
  if (!recipe) throw error('Unknown project template: ' + template);
  return recipe.request(description.replace(/\s+/g, ' ').trim());
}

/** Step 1: validate, draft the project and compose the request. Writes no files. */
function draft(store, deps, input = {}) {
  const description = String(input.description || '').trim();
  if (description.length < 8) throw error('Describe the app in a sentence or two: what it shows and what it should do.');
  if (description.length > MAX_DESCRIPTION) throw error(`Keep the description under ${MAX_DESCRIPTION} characters.`);
  const modelId = String(input.modelId || '').trim();
  if (!modelId) throw error('Choose the local model that should write the code.');
  const parent = deps.scanner.approvedRoot(store, input.parentRootId);
  const template = input.template ? String(input.template) : suggestTemplate(description);
  if (!RECIPES[template]) throw error('Choose one of these templates: ' + Object.keys(RECIPES).join(', ') + '.');
  const name = input.name ? String(input.name).trim() : suggestName(description, n => fs.existsSync(path.join(parent.path, n)));
  const title = input.title ? String(input.title).trim() : titleFrom(name);
  const project = deps.projects.draftProject(store, deps.scanner, { parentRootId: parent.id, name, title, template });
  const request = composeRequest(template, description);
  const maxAttempts = Math.max(1, Math.min(5, Math.round(Number(input.maxAttempts) || 3)));
  const build = {
    id: 'app_' + crypto.randomBytes(8).toString('hex'), type: 'app-build', status: 'drafted',
    description, template, templateLabel: project.templateLabel, needsInstall: project.needsInstall,
    name, title, parentRootId: parent.id, targetPath: project.targetPath,
    modelId, maxAttempts, request, focusFiles: RECIPES[template].files,
    projectId: project.id, rootId: null, loopId: null, batchId: null,
    commands: COMMANDS, error: null, createdAt: now(), updatedAt: now(),
    files: project.files,
  };
  store.put(STORE, build);
  return build;
}

function save(store, build) { build.updatedAt = now(); store.put(STORE, build); return build; }

/** Step 2: create the project, allow its commands, start the development loop. */
function start(store, deps, id) {
  const build = get(store, id);
  if (build.status !== 'drafted') throw error('This app build has already started.', 409);
  const created = deps.projects.createProject(store, deps.scanner, build.projectId);
  build.rootId = created.created.rootId;
  build.targetPath = created.created.path;
  build.gitNote = created.created.gitNote;
  build.status = 'created';
  save(store, build);
  try {
    deps.runner.allowRepository(store, deps.scanner, build.rootId, COMMANDS);
    const { loop, done } = deps.devLoop.startLoop(store, deps.loopDeps, { rootId: build.rootId, request: build.request, modelId: build.modelId, maxAttempts: build.maxAttempts });
    build.loopId = loop.id;
    build.status = 'building';
    save(store, build);
    Promise.resolve(done).then(() => settle(store, build.id)).catch(() => settle(store, build.id));
  } catch (cause) {
    build.status = 'failed';
    build.error = cause.message || String(cause);
    save(store, build);
    if (deps.audit) deps.audit({ action: 'app.build.failed', buildId: build.id, rootId: build.rootId });
    throw Object.assign(cause, { build });
  }
  if (deps.audit) deps.audit({ action: 'app.build.started', buildId: build.id, rootId: build.rootId, loopId: build.loopId, template: build.template });
  return build;
}

const LOOP_TO_BUILD = { ready: 'ready', 'checks-failed': 'needs-attention', 'attempts-exhausted': 'needs-attention', 'no-changes': 'needs-attention', conflict: 'needs-attention', cancelled: 'cancelled', error: 'failed', interrupted: 'failed' };

/** Copies the finished loop's outcome onto the build. Safe to call repeatedly. */
function settle(store, id) {
  const build = store.get(STORE, id);
  if (!build || !build.loopId) return build;
  const loop = store.get('workspaceLoops', build.loopId);
  if (!loop) return build;
  if (build.status === 'building' && LOOP_TO_BUILD[loop.status]) {
    build.status = LOOP_TO_BUILD[loop.status];
    build.batchId = loop.batchId || null;
    build.error = loop.error || null;
    save(store, build);
  }
  if (build.batchId && ['ready', 'needs-attention'].includes(build.status)) {
    const batch = store.get('workspaceChangeBatches', build.batchId);
    if (batch && /appl|executed/.test(String(batch.status)) && !/rolled/.test(String(batch.status))) { build.status = 'applied'; save(store, build); }
  }
  return build;
}

function view(store, build) {
  const loop = build.loopId ? store.get('workspaceLoops', build.loopId) : null;
  const batch = build.batchId ? store.get('workspaceChangeBatches', build.batchId) : null;
  return {
    ...build,
    loop: loop ? { id: loop.id, status: loop.status, phase: loop.phase, attempts: (loop.attempts || []).map(a => ({ number: a.number, status: a.status, test: a.test ? { status: a.test.status, outputTail: String(a.test.outputTail || '').slice(-1500) } : null, applyError: a.applyError || null })), baseline: loop.baseline ? { status: loop.baseline.status } : null, error: loop.error } : null,
    batch: batch ? { id: batch.id, status: batch.status, files: batch.orderedFiles || [], checks: (batch.checks || []).map(c => ({ name: c.name || c.label || c.id, status: c.status || (c.ok === false ? 'failed' : 'passed') })) } : null,
  };
}

function get(store, id) {
  const build = store.get(STORE, String(id || ''));
  if (!build) throw error('Unknown app build.', 404);
  return build;
}
function detail(store, id) { return view(store, settle(store, get(store, id).id)); }
function list(store) { return store.all(STORE).map(b => view(store, settle(store, b.id))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }

function recoverInterrupted(store) {
  let n = 0;
  for (const build of store.all(STORE)) {
    if (build.status === 'building') { settle(store, build.id); n++; }
  }
  return n;
}

module.exports = { STORE, RECIPES, COMMANDS, suggestTemplate, suggestName, titleFrom, composeRequest, defaultProjectsDir, ensureProjectsRoot, draft, start, settle, detail, list, recoverInterrupted };
