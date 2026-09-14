'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
const workspaceDir = '/private/tmp/nova-e2e-workspace';
fs.rmSync(workspaceDir, { recursive: true, force: true });
fs.mkdirSync(workspaceDir, { recursive: true });
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
const { server } = require('../server');

function shutdown() {
  server.close(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
