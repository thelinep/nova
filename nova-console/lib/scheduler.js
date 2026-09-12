'use strict';
/* ===========================================================================
 * NOVA Runtime — automations scheduler & event receiver (Phase 5)
 *
 * Closes the last fake this project's automations had: "Run now" became a
 * real pipeline run earlier in Phase 5, but nothing ever fired one on its
 * own — the seeded trigger.detail strings ("Every day at 07:30", "File
 * added to Project Docs") were just labels nothing read. This module makes
 * both trigger kinds real:
 *
 *  - schedule triggers get a real structured {kind, ...} shape, real cron-
 *    style next-run math (computeNextRun), and a real setInterval tick that
 *    fires a run and reschedules from the actual completion time — no
 *    client, browser tab, or manual click involved.
 *  - event triggers get a real receiver: onDocumentIngested() is called by
 *    server.js right after lib/knowledge.js's ingestDocument() really adds
 *    a document to a collection, and it fires any automation actually
 *    watching that collection. "File added" is a genuine event, not a
 *    30-second poll pretending to notice one.
 *
 * Missed-schedule handling: if the process was down (or never running)
 * across a nextRun, that slot is not replayed retroactively — it would
 * either fire hours late or pile up one run per missed tick over a long
 * outage. On startup, any overdue schedule gets a fresh nextRun computed
 * from *now* instead, the same "skip what you missed" default most cron
 * daemons use, and the skip itself is written to the real event log rather
 * than silently dropped.
 * ========================================================================= */
const { logExecution, uid } = require('./exec-log');
const { searchKnowledge } = require('./knowledge');

const TICK_MS = 15000;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n) { return String(n).padStart(2, '0'); }
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------ trigger math ------------------------------ */

function normalizeSchedule(schedule) {
  schedule = schedule || {};
  const kind = ['interval', 'daily', 'weekly'].includes(schedule.kind) ? schedule.kind : 'daily';
  if (kind === 'interval') return { kind, everyMinutes: clampInt(schedule.everyMinutes, 1, 10080, 60) };
  if (kind === 'weekly') return { kind, weekday: clampInt(schedule.weekday, 0, 6, 0), hour: clampInt(schedule.hour, 0, 23, 7), minute: clampInt(schedule.minute, 0, 59, 30) };
  return { kind, hour: clampInt(schedule.hour, 0, 23, 7), minute: clampInt(schedule.minute, 0, 59, 30) };
}

/** Real next-run math — deterministic, pure, unit-testable in isolation.
 *  `from` is exclusive: the returned instant is always strictly after it,
 *  so calling this again with its own result keeps advancing forever. */
function computeNextRun(schedule, from) {
  const base = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (!schedule || !schedule.kind) return null;
  if (schedule.kind === 'interval') {
    const everyMinutes = clampInt(schedule.everyMinutes, 1, 10080, 60);
    return new Date(base.getTime() + everyMinutes * 60000);
  }
  if (schedule.kind === 'daily') {
    const hour = clampInt(schedule.hour, 0, 23, 0), minute = clampInt(schedule.minute, 0, 59, 0);
    const next = new Date(base); next.setSeconds(0, 0); next.setHours(hour, minute, 0, 0);
    if (next <= base) next.setDate(next.getDate() + 1);
    return next;
  }
  if (schedule.kind === 'weekly') {
    const weekday = clampInt(schedule.weekday, 0, 6, 0), hour = clampInt(schedule.hour, 0, 23, 0), minute = clampInt(schedule.minute, 0, 59, 0);
    const next = new Date(base); next.setSeconds(0, 0); next.setHours(hour, minute, 0, 0);
    let dayDiff = (weekday - next.getDay() + 7) % 7;
    if (dayDiff === 0 && next <= base) dayDiff = 7;
    next.setDate(next.getDate() + dayDiff);
    return next;
  }
  return null;
}

function describeTrigger(trigger) {
  if (!trigger) return 'Not configured';
  if (trigger.type === 'event') {
    const evName = trigger.event === 'document_added' ? 'File added' : (trigger.event || 'Event');
    return evName + (trigger.collectionName ? (' to "' + trigger.collectionName + '"') : (trigger.collectionId ? ' to collection' : ' — no collection chosen yet'));
  }
  const s = trigger.schedule;
  if (!s) return 'Not yet scheduled';
  if (s.kind === 'interval') return 'Every ' + s.everyMinutes + ' minute' + (s.everyMinutes === 1 ? '' : 's');
  if (s.kind === 'daily') return 'Every day at ' + pad2(s.hour) + ':' + pad2(s.minute);
  if (s.kind === 'weekly') return WEEKDAY_NAMES[s.weekday] + 's at ' + pad2(s.hour) + ':' + pad2(s.minute);
  return 'Not yet scheduled';
}

/** Validates + fills in a trigger patch from the frontend into the real
 *  stored shape, deriving `detail` from the structured fields so the
 *  display string can never drift from what will actually fire. */
function normalizeTrigger(trigger, store) {
  if (trigger && trigger.type === 'event') {
    const collectionId = trigger.collectionId || null;
    const collection = collectionId ? store.get('knowledgeCollections', collectionId) : null;
    const t = { type: 'event', event: 'document_added', collectionId };
    t.detail = describeTrigger({ ...t, collectionName: collection ? collection.name : null });
    return t;
  }
  const schedule = normalizeSchedule(trigger && trigger.schedule);
  const t = { type: 'schedule', schedule };
  t.detail = describeTrigger(t);
  return t;
}

/* -------------------------------- run logic -------------------------------- */

/** The real pipeline run itself — moved here unchanged in substance from
 *  server.js's POST /api/automations/:id/run so manual, scheduled, and
 *  event-triggered runs are all the exact same code path, differing only
 *  in `origin` (which just changes the audit-trail wording). */
async function runAutomation(store, ollama, automationId, opts) {
  const origin = (opts && opts.origin) || 'manual';
  const originLabel = origin === 'schedule' ? 'scheduled' : origin === 'event' ? 'event-triggered' : 'manual';
  const a = store.get('automations', automationId);
  if (!a) { const e = new Error('Unknown automation: ' + automationId); e.statusCode = 404; throw e; }
  const model = store.get('models', a.modelId);
  const modelName = model ? model.id : a.modelId;
  const startedAt = new Date().toISOString();
  const exec = logExecution(store, 'automation', a.name + ' · run', 'running', 'Started (' + originLabel + ')', a.id);
  const runLogs = [];
  try {
    let contextText = '';
    let chunkCount = 0;
    for (const collectionId of (a.collections || [])) {
      const result = await searchKnowledge(store, ollama, { query: a.name, collectionId, topK: 4 });
      if (result.results && result.results.length) {
        chunkCount += result.results.length;
        contextText += result.results.map(r => '- ' + r.text).join('\n') + '\n';
      }
    }
    runLogs.push(chunkCount
      ? ('Retrieved ' + chunkCount + ' real chunk(s) across ' + (a.collections || []).length + ' collection(s)')
      : ((a.collections || []).length ? 'No embedded chunks found in this automation’s collection(s) yet' : 'No collections configured — generating with no retrieval context'));
    const triggerNote = origin === 'schedule' ? 'Triggered automatically by the real scheduler — no click involved'
      : origin === 'event' ? 'Triggered automatically by the real event receiver — a document was actually added to a watched collection'
      : 'Triggered manually';
    runLogs.push(triggerNote);

    const messages = [
      { role: 'system', content: 'You are executing a workspace automation named "' + a.name + '" (trigger: ' + ((a.trigger && a.trigger.detail) || 'manual') + '). Use only the provided context; say plainly if nothing relevant was retrieved rather than inventing details.' },
      { role: 'user', content: (contextText ? ('Context:\n' + contextText.slice(0, 6000) + '\n\n') : '') + 'Produce this automation’s result now.' },
    ];
    const raw = await ollama.chatFull(modelName, messages, { options: { temperature: 0.4 } });
    const finishedAt = new Date().toISOString();
    const durationSec = raw.total_duration != null ? raw.total_duration / 1e9 : (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
    const tokens = raw.eval_count || 0;
    const outputText = (raw.message && raw.message.content) || '';

    runLogs.push('Generated real reply via ' + modelName + ' · ' + tokens + ' tokens (real eval_count)');
    a.lastRun = startedAt;
    a.lastDuration = durationSec.toFixed(1) + 's';
    a.lastTokens = tokens;
    a.logs = [...(a.logs || []).slice(-(6 - runLogs.length)), ...runLogs];
    store.put('automations', a);
    store.put('automationRuns', { id: uid('run'), automationId: a.id, status: 'Success', startedAt, duration: a.lastDuration, tokens, origin });
    const exRow = store.get('executions', exec.id);
    if (exRow) { exRow.status = 'success'; exRow.finishedAt = finishedAt; exRow.detail = tokens + ' tokens · ' + a.lastDuration + ' (' + originLabel + ')'; store.put('executions', exRow); }
    if (origin !== 'manual') {
      store.put('runtimeEvents', { id: uid('ev'), at: finishedAt, category: 'AUTOMATION', message: a.name + ' · ' + originLabel + ' run succeeded · ' + tokens + ' tokens', extra: null });
    }
    return { automation: a, output: outputText, tokens, duration: a.lastDuration };
  } catch (e) {
    const finishedAt = new Date().toISOString();
    a.lastRun = startedAt; a.lastDuration = null; a.lastTokens = 0;
    a.logs = [...(a.logs || []).slice(-5), 'Run failed (' + originLabel + ') — ' + (e.message || String(e))];
    store.put('automations', a);
    store.put('automationRuns', { id: uid('run'), automationId: a.id, status: 'Failed', startedAt, duration: null, tokens: 0, origin });
    const exRow = store.get('executions', exec.id);
    if (exRow) { exRow.status = 'error'; exRow.finishedAt = finishedAt; exRow.detail = (e.message || String(e)) + ' (' + originLabel + ')'; store.put('executions', exRow); }
    if (origin !== 'manual') {
      store.put('runtimeEvents', { id: uid('ev'), at: finishedAt, category: 'ERROR', message: a.name + ' · ' + originLabel + ' run failed: ' + (e.message || String(e)), extra: null });
    }
    throw e;
  }
}

/* ------------------------------- configuration ------------------------------ */

/** The one real place nextRun is ever computed. The frontend never sends a
 *  nextRun value — it can only be a pure function of the current trigger +
 *  status, or it could silently drift from what will actually fire. */
function configureAutomation(store, id, patch) {
  const a = store.get('automations', id);
  if (!a) { const e = new Error('Unknown automation: ' + id); e.statusCode = 404; throw e; }
  if (patch.name != null) { const n = String(patch.name).trim().slice(0, 200); if (n) a.name = n; }
  if (patch.modelId != null) a.modelId = patch.modelId;
  if (Array.isArray(patch.collections)) a.collections = patch.collections.filter(id => store.get('knowledgeCollections', id));
  if (patch.trigger) a.trigger = normalizeTrigger(patch.trigger, store);
  if (patch.status != null) {
    if (!['Draft', 'Enabled'].includes(patch.status)) { const e = new Error('status must be "Draft" or "Enabled"'); e.statusCode = 400; throw e; }
    a.status = patch.status;
  }
  if (a.status === 'Enabled' && a.trigger && a.trigger.type === 'schedule') {
    const next = computeNextRun(a.trigger.schedule, new Date());
    a.nextRun = next ? next.toISOString() : null;
  } else {
    a.nextRun = null; // event triggers have no "next run" — they wait; disabled automations don't run at all
  }
  store.put('automations', a);
  return a;
}

function createAutomation(store, patch) {
  const models = store.all('models');
  const a = {
    id: uid('auto'), name: (patch && patch.name && String(patch.name).trim()) || 'New automation',
    status: 'Draft', modelId: (patch && patch.modelId) || (models[0] && models[0].id) || null,
    collections: [], lastRun: null, nextRun: null, lastDuration: null, lastTokens: null, logs: [],
    trigger: normalizeTrigger({ type: 'schedule', schedule: { kind: 'daily', hour: 7, minute: 30 } }, store),
  };
  store.put('automations', a);
  return a;
}

/* -------------------------------- the ticker -------------------------------- */

let schedulerState = { running: false, tickMs: TICK_MS, startedAt: null, lastTickAt: null, lastCatchUp: null };
let tickTimer = null;
const firingIds = new Set(); // automations currently mid-run, so a 15s tick can't re-fire one still running from the last tick

function fireAndReschedule(store, ollama, automationId, origin) {
  firingIds.add(automationId);
  runAutomation(store, ollama, automationId, { origin })
    .catch(e => console.error('[nova-runtime] ' + origin + '-triggered automation run failed', automationId, e.message || e))
    .finally(() => {
      firingIds.delete(automationId);
      if (origin !== 'schedule') return;
      // Reschedule from the real completion time, not the original due
      // time — a slow run doesn't cause the next one to fire immediately
      // behind it, and a disabled/reconfigured-mid-run automation doesn't
      // get an unwanted nextRun re-added underneath the user.
      const fresh = store.get('automations', automationId);
      if (fresh && fresh.status === 'Enabled' && fresh.trigger && fresh.trigger.type === 'schedule') {
        const next = computeNextRun(fresh.trigger.schedule, new Date());
        fresh.nextRun = next ? next.toISOString() : null;
        store.put('automations', fresh);
      }
    });
}

function tick(store, ollama) {
  schedulerState.lastTickAt = new Date().toISOString();
  const now = Date.now();
  for (const a of store.all('automations')) {
    if (a.status !== 'Enabled' || !a.trigger || a.trigger.type !== 'schedule') continue;
    if (!a.nextRun || Date.parse(a.nextRun) > now) continue;
    if (firingIds.has(a.id)) continue; // still running from a previous tick — don't double-fire
    fireAndReschedule(store, ollama, a.id, 'schedule');
  }
}

/** Called once at process startup. Ticks every `tickMs` from then on
 *  (default 15s — coarse enough to be cheap, fine enough that "every N
 *  minutes" schedules are never more than 15s late). Also runs the
 *  missed-schedule catch-up described in the module header. */
function startScheduler(store, ollama, opts) {
  const tickMs = (opts && opts.tickMs) || TICK_MS;
  schedulerState = { running: true, tickMs, startedAt: new Date().toISOString(), lastTickAt: null, lastCatchUp: null };

  const now = new Date();
  let rescheduled = 0;
  for (const a of store.all('automations')) {
    if (a.status !== 'Enabled' || !a.trigger || a.trigger.type !== 'schedule') continue;
    if (!a.nextRun || Date.parse(a.nextRun) <= now.getTime()) {
      const next = computeNextRun(a.trigger.schedule, now);
      a.nextRun = next ? next.toISOString() : null;
      store.put('automations', a);
      rescheduled++;
    }
  }
  if (rescheduled) {
    schedulerState.lastCatchUp = { at: now.toISOString(), rescheduled };
    store.put('runtimeEvents', {
      id: uid('ev'), at: now.toISOString(), category: 'AUTOMATION',
      message: 'Scheduler startup: ' + rescheduled + ' automation(s) had a next run already in the past (server was stopped through it) — rescheduled from now rather than replayed late.',
      extra: null,
    });
  }

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => tick(store, ollama), tickMs);
  if (tickTimer.unref) tickTimer.unref(); // never keeps the process alive on its own
  return schedulerState;
}

function getSchedulerStatus(store) {
  const enabled = store.all('automations').filter(a => a.status === 'Enabled' && a.trigger && a.trigger.type === 'schedule');
  const nextDueAt = enabled.reduce((min, a) => (a.nextRun && (!min || a.nextRun < min)) ? a.nextRun : min, null);
  return {
    running: schedulerState.running, tickMs: schedulerState.tickMs, startedAt: schedulerState.startedAt,
    lastTickAt: schedulerState.lastTickAt, lastCatchUp: schedulerState.lastCatchUp,
    enabledScheduleCount: enabled.length, firing: firingIds.size, nextDueAt,
  };
}

/* -------------------------------- event receiver ------------------------------ */

/** The real event receiver. Call this right after a document has actually
 *  been added to `collectionId` (server.js does, immediately after
 *  ingestDocument() succeeds) — anything watching that exact collection
 *  fires for real, no polling involved. */
function onDocumentIngested(store, ollama, collectionId) {
  if (!collectionId) return;
  for (const a of store.all('automations')) {
    if (a.status !== 'Enabled' || !a.trigger || a.trigger.type !== 'event') continue;
    if (a.trigger.event !== 'document_added' || a.trigger.collectionId !== collectionId) continue;
    if (firingIds.has(a.id)) continue;
    fireAndReschedule(store, ollama, a.id, 'event');
  }
}

module.exports = {
  WEEKDAY_NAMES, computeNextRun, describeTrigger, normalizeTrigger,
  runAutomation, configureAutomation, createAutomation,
  startScheduler, getSchedulerStatus, onDocumentIngested,
};
