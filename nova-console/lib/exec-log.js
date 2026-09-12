'use strict';
/* ===========================================================================
 * NOVA Runtime — shared execution-log helper
 *
 * Split out of server.js in Phase 5's scheduler work: the automations
 * scheduler (lib/scheduler.js) needs to write the same {id,type,label,
 * status,detail,relatedId,startedAt,finishedAt} rows server.js's request
 * handlers already write for agent runs and workflow steps, and it needs
 * to do it from a background tick with no request/response in play — not
 * a good reason to require server.js from a lib module. One tiny shared
 * helper instead of two copies drifting apart.
 * ========================================================================= */

function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function logExecution(store, type, label, status, detail, relatedId) {
  const ex = {
    id: uid('ex'), type, label, status, detail: detail || '', relatedId: relatedId || null,
    startedAt: new Date().toISOString(), finishedAt: (status === 'running' || status === 'pending') ? null : new Date().toISOString(),
  };
  store.put('executions', ex);
  return ex;
}

module.exports = { uid, logExecution };
