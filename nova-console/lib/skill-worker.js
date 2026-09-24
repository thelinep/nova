'use strict';
/* ===========================================================================
 * NOVA Runtime — skill worker entrypoint (Phase 3)
 *
 * Runs inside a node:worker_threads Worker, in its own V8 isolate. The only
 * way this code can reach an MCP tool is through the `tools` object built
 * below from the skill's OWN DECLARED requiredTools — a tool name the
 * skill didn't list in its manifest simply has no entry here, so there's
 * nothing to call. Every call that does go through `tools.*` round-trips
 * to the main thread's gatedCall(), so a server's approval policy applies
 * to it exactly as it would to a manual "Call" click in the MCP view.
 *
 * Honest scope note: this isolates the skill from the MAIN THREAD's live
 * state (MCP connections, the SQLite store, pending approvals) and gives it
 * no ambient capability beyond its declared tools — real isolation for a
 * first-party skill that behaves. It is not a security sandbox against an
 * actively malicious module: Node doesn't restrict what a worker's own
 * `require()` can reach, so this doesn't stop a skill that deliberately
 * imports `fs` or `child_process` itself. Real OS-level sandboxing (a
 * locked-down vm.Context, or a separate process with resource limits)
 * would be the next increment, not attempted here.
 * ========================================================================= */
const { parentPort, workerData } = require('worker_threads');

async function main() {
  const { entrypointPath, inputs, requiredTools, hostMethods } = workerData;

  let mod;
  try {
    mod = require(entrypointPath);
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: 'Failed to load skill module: ' + e.message });
    return;
  }
  if (typeof mod.run !== 'function') {
    parentPort.postMessage({ type: 'error', error: 'Skill module does not export a run(inputs, tools) function' });
    return;
  }

  let callSeq = 1;
  const pending = new Map();
  parentPort.on('message', msg => {
    if (msg && (msg.type === 'tool-result' || msg.type === 'host-result') && pending.has(msg.callId)) {
      const p = pending.get(msg.callId);
      pending.delete(msg.callId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  const tools = {};
  for (const toolName of requiredTools || []) {
    tools[toolName] = (args) => new Promise((resolve, reject) => {
      const callId = callSeq++;
      pending.set(callId, { resolve, reject });
      parentPort.postMessage({ type: 'tool-call', callId, toolName, args: args || {} });
    });
  }

  // Host methods (lib/skill-host.js) round-trip the same way; only the
  // names the main thread granted exist on this object.
  const host = {};
  for (const method of hostMethods || []) {
    host[method] = (args) => new Promise((resolve, reject) => {
      const callId = callSeq++;
      pending.set(callId, { resolve, reject });
      parentPort.postMessage({ type: 'host-call', callId, method, args: args || {} });
    });
  }

  try {
    const result = await mod.run(inputs || {}, tools, host);
    parentPort.postMessage({ type: 'done', result });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e.message || String(e) });
  }
}

main();
