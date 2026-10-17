'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workspaceDir = validateWorkspaceDirectory(process.env.NOVA_E2E_WORKSPACE);
const workspaceStat = fs.lstatSync(workspaceDir);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
fs.writeFileSync(path.join(workspaceDir, 'draft.json'), '{"version":"0.1.0"}\n');
fs.writeFileSync(path.join(workspaceDir, 'feature.js'), 'const enabled = false;\n');
fs.writeFileSync(path.join(workspaceDir, 'batch-config.json'), '{"enabled":false}\n');
fs.writeFileSync(path.join(workspaceDir, 'batch-main.js'), 'const enabled = false;\n');
execFileSync('git', ['init', '-q'], { cwd: workspaceDir });
execFileSync('git', ['config', 'user.name', 'NOVA E2E'], { cwd: workspaceDir });
execFileSync('git', ['config', 'user.email', 'nova-e2e@example.invalid'], { cwd: workspaceDir });
execFileSync('git', ['add', 'draft.json', 'feature.js', 'batch-config.json', 'batch-main.js'], { cwd: workspaceDir });
execFileSync('git', ['commit', '-qm', 'Initial fixture'], { cwd: workspaceDir });
process.env.DATA_DIR = dataDir;
process.env.NOVA_LIBRARY_DIR = path.join(dataDir, 'library'); // never write test output into the real ~/Documents/NOVA Library
process.env.NOVA_PROJECTS_DIR = path.join(dataDir, 'Maataa Projects'); // App Builder never creates ~/Maataa Projects during tests
// Character Studio "Make 3D mesh": a stand-in for TripoSR that copies a small fixture mesh (tests/fixtures/fake-triposr.js).
if (!process.env.NOVA_TRIPOSR_PYTHON) { process.env.NOVA_TRIPOSR_PYTHON = process.execPath; process.env.NOVA_TRIPOSR_SCRIPT = path.join(__dirname, 'fixtures', 'fake-triposr.js'); process.env.NOVA_TRIPOSR_DIR = path.join(dataDir, 'tools', 'triposr'); }
const { server } = require('../server');

function validateWorkspaceDirectory(candidate) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = typeof candidate === 'string' ? path.resolve(candidate) : '';
  const basename = path.basename(resolved);
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate) || resolved !== candidate ||
      path.dirname(resolved) !== tempRoot || !/^nova-e2e-workspace-[A-Za-z0-9_-]{6,}$/.test(basename)) {
    throw new Error('NOVA_E2E_WORKSPACE must be a unique nova-e2e-workspace-* directory directly under the OS temp directory.');
  }

  const parent = fs.realpathSync(path.dirname(resolved));
  if (parent !== fs.realpathSync(tempRoot)) {
    throw new Error('NOVA_E2E_WORKSPACE must resolve directly under the OS temp directory.');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(resolved).length !== 0) {
    throw new Error('NOVA_E2E_WORKSPACE must be an existing, empty, non-symlink directory created for this run.');
  }
  return resolved;
}

function cleanupWorkspaceDirectory() {
  try {
    const current = fs.lstatSync(workspaceDir);
    const sameDirectory = current.isDirectory() && !current.isSymbolicLink() &&
      current.dev === workspaceStat.dev && current.ino === workspaceStat.ino &&
      fs.realpathSync(path.dirname(workspaceDir)) === fs.realpathSync(path.resolve(os.tmpdir()));
    if (sameDirectory) fs.rmSync(workspaceDir, { recursive: true });
  } catch (_) {
    // Fail closed: leave the path alone if its identity or temporary parent changed.
  }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    cleanupWorkspaceDirectory();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
