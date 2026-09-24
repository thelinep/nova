'use strict';
/* ===========================================================================
 * NOVA Runtime — new local projects
 *
 * Two explicit steps, like every other write NOVA makes:
 *   draftProject   validates the name, template and destination and lists
 *                  the exact files that would be written. Nothing touches disk.
 *   createProject  writes those files into a hidden staging folder inside the
 *                  approved parent, runs `git init` (and an initial commit when
 *                  a git identity is configured), then renames the staging
 *                  folder into place in one step and approves it as a root.
 *                  If anything fails, the staging folder is removed and the
 *                  destination never appears half-written.
 * The parent folder must already be an approved root. Nothing is downloaded;
 * templates that need packages say so, and installing is a separate step.
 * ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const templates = require('./project-templates');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const TITLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,-]{0,79}$/;
const RESERVED = new Set(['node_modules', 'dist', 'build', 'target', 'coverage']);

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitIdentity(cwd) {
  try { return { name: git(cwd, ['config', 'user.name']), email: git(cwd, ['config', 'user.email']) }; }
  catch (_) { return null; }
}

function draftProject(store, scanner, input = {}) {
  const parent = scanner.approvedRoot(store, input.parentRootId);
  const name = String(input.name || '').trim();
  if (!NAME_PATTERN.test(name) || RESERVED.has(name)) throw error('Use a project name of lowercase letters, numbers, dashes or underscores (up to 64 characters), starting with a letter or number.');
  const title = input.title == null || input.title === '' ? templates.titleFor(name) : String(input.title).trim();
  if (!TITLE_PATTERN.test(title)) throw error('Use a title of letters, numbers, spaces, dots, commas or dashes (up to 80 characters).');
  const templateId = String(input.template || '');
  const files = templates.render(templateId, name, title);
  if (!files) throw error('Unknown project template: ' + templateId);
  const targetPath = path.join(parent.path, name);
  if (fs.existsSync(targetPath)) throw error('A file or folder named "' + name + '" already exists in ' + parent.label + '.', 409);
  const template = templates.TEMPLATES[templateId];
  const now = new Date().toISOString();
  const draft = {
    id: 'project_' + hash(parent.id + '|' + name + '|' + now).slice(0, 16),
    type: 'workspace-project-draft', status: 'draft',
    parentRootId: parent.id, parentPath: parent.path, name, title,
    template: templateId, templateLabel: template.label, needsInstall: template.needsInstall,
    targetPath, createdAt: now, updatedAt: now,
    files: files.map(file => ({ relativePath: file.relativePath, bytes: Buffer.byteLength(file.content), sha256: hash(file.content) })),
    nextSteps: template.needsInstall ? ['Install packages (npm install) before dev or build.', 'npm test works now.'] : ['npm test and npm start work now; no install needed.'],
    created: null,
  };
  store.put('workspaceProjects', draft);
  return draft;
}

function createProject(store, scanner, id) {
  const draft = store.get('workspaceProjects', id);
  if (!draft) throw error('Unknown project draft.', 404);
  if (draft.status !== 'draft') throw error('This project draft was already used.', 409);
  const parent = scanner.approvedRoot(store, draft.parentRootId);
  if (parent.path !== draft.parentPath) throw error('The parent folder moved after drafting. Draft the project again.', 409);
  if (fs.existsSync(draft.targetPath)) throw error('"' + draft.name + '" appeared in the parent folder after drafting. Nothing was written.', 409);

  const files = templates.render(draft.template, draft.name, draft.title);
  const expected = new Map(draft.files.map(file => [file.relativePath, file.sha256]));
  if (files.length !== expected.size || files.some(file => expected.get(file.relativePath) !== hash(file.content))) {
    throw error('The template changed since this draft was made. Draft the project again.', 409);
  }

  const staging = path.join(parent.path, '.nova-new-' + draft.id);
  let commit = null;
  let gitNote;
  try {
    fs.mkdirSync(staging);
    for (const file of files) {
      const out = path.join(staging, file.relativePath);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content, { flag: 'wx' });
    }
    git(staging, ['init', '--quiet']);
    git(staging, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const identity = gitIdentity(staging);
    if (identity && identity.name && identity.email) {
      git(staging, ['add', '--all']);
      git(staging, ['commit', '--quiet', '--no-verify', '-m', 'chore: create ' + draft.name + ' from the ' + draft.templateLabel + ' template']);
      commit = git(staging, ['rev-parse', 'HEAD']);
      gitNote = 'Initialized on branch main with an initial commit.';
    } else {
      gitNote = 'Initialized on branch main. No initial commit because git user.name and user.email are not configured.';
    }
    if (fs.existsSync(draft.targetPath)) throw error('"' + draft.name + '" appeared while the project was being created.', 409);
    fs.renameSync(staging, draft.targetPath);
  } catch (cause) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    if (cause.statusCode) throw cause;
    throw error('Project creation failed and nothing was left behind: ' + String(cause.stderr || cause.message).trim().slice(0, 500), 500);
  }

  const root = scanner.approveRoot(store, { path: draft.targetPath, label: draft.title });
  const now = new Date().toISOString();
  draft.status = 'created';
  draft.updatedAt = now;
  draft.created = { at: now, path: root.path, rootId: root.id, files: files.length, commit, gitNote };
  store.put('workspaceProjects', draft);
  return draft;
}

module.exports = { draftProject, createProject, listTemplates: templates.listTemplates, NAME_PATTERN };
