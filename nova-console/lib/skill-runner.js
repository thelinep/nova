'use strict';
/* ===========================================================================
 * NOVA Runtime — sandboxed skill runner (Phase 3)
 *
 * Runs a skill's real entrypoint module (skills/<id-without-skl_>.js) in an
 * isolated worker thread (see lib/skill-worker.js for what "isolated" means
 * here, honestly scoped). The caller supplies one function, `gatedCall`,
 * that resolves a bare tool name to its MCP server and runs it through the
 * real approval gate in lib/mcp-manager.js — this file never talks to MCP
 * servers directly.
 * ========================================================================= */
const path = require('path');
const { Worker } = require('worker_threads');
const { validateManifest } = require('./skill-schema');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const WORKER_PATH = path.join(__dirname, 'skill-worker.js');
const RUN_TIMEOUT_MS = 60000;

function httpErr(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

/** @param skill the DB.skills row. @param inputs plain object passed to the
 *  module's run(). @param gatedCall (toolName, args) => Promise<result>,
 *  already bound to the right MCP server and approval policy by the caller. */
function runSkillSandboxed(skill, inputs, gatedCall) {
  const manifestCheck = validateManifest(skill.manifest);
  if (!manifestCheck.valid) {
    throw httpErr(400, 'Skill manifest for "' + skill.name + '" failed validation: ' + manifestCheck.errors.join('; '));
  }
  const entryName = skill.id.replace(/^skl_/, '') + '.js';
  const entrypointPath = path.join(SKILLS_DIR, entryName);

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_PATH, {
        workerData: {
          entrypointPath,
          inputs: inputs || {},
          requiredTools: (skill.manifest && skill.manifest.requiredTools) || [],
        },
      });
    } catch (e) {
      reject(httpErr(500, 'Failed to start sandboxed worker: ' + e.message));
      return;
    }

    const timer = setTimeout(() => {
      worker.terminate();
      reject(httpErr(504, 'Skill "' + skill.name + '" timed out after ' + RUN_TIMEOUT_MS + 'ms'));
    }, RUN_TIMEOUT_MS);

    worker.on('message', async msg => {
      if (msg.type === 'tool-call') {
        try {
          const result = await gatedCall(msg.toolName, msg.args);
          worker.postMessage({ type: 'tool-result', callId: msg.callId, result });
        } catch (e) {
          worker.postMessage({ type: 'tool-result', callId: msg.callId, error: e.message || String(e) });
        }
        return;
      }
      if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg.result); return; }
      if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(httpErr(500, msg.error)); return; }
    });
    worker.on('error', e => { clearTimeout(timer); reject(httpErr(500, e.message)); });
  });
}

module.exports = { runSkillSandboxed, SKILLS_DIR };
