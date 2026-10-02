'use strict';
/* ===========================================================================
 * Activity: live, step-by-step progress for everything NOVA is doing
 *
 * A job is one piece of work (a chat reply, reading a folder, cloning a repo,
 * a computer action). It has plain-language steps that go running → done /
 * failed, so the console can show what is happening while it happens, and
 * several jobs can run at once. Jobs live in memory while they run, are saved
 * to the chatJobs store (throttled) and pushed to listeners (the SSE stream).
 * ========================================================================= */
const crypto = require('node:crypto');

const jobs = new Map();            // id -> job (running and recent)
const controllers = new Map();     // id -> AbortController
const listeners = new Set();       // fn(event)
let storeRef = null;
const saveTimers = new Map();
const MAX_RECENT = 60;

function configure(store) { storeRef = store; recoverInterrupted(); }
function now() { return new Date().toISOString(); }
function newId(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function publish(type, job) {
  const event = { type, job: publicJob(job) };
  for (const fn of listeners) { try { fn(event); } catch (_) { /* a closed stream */ } }
  scheduleSave(job, type === 'job.finished' || type === 'job.created');
}

function scheduleSave(job, immediate) {
  if (!storeRef) return;
  const save = () => { saveTimers.delete(job.id); try { storeRef.put('chatJobs', publicJob(job)); } catch (_) {} };
  if (immediate) { clearTimeout(saveTimers.get(job.id)); save(); return; }
  if (!saveTimers.has(job.id)) saveTimers.set(job.id, setTimeout(save, 400));
}

function publicJob(job) {
  return { id: job.id, kind: job.kind, title: job.title, sessionId: job.sessionId || null, status: job.status, startedAt: job.startedAt,
    finishedAt: job.finishedAt || null, error: job.error || null, result: job.result || null, steps: job.steps.map(s => ({ ...s })), cancellable: controllers.has(job.id) && job.status === 'running' };
}

/** Starts a job. Returns a handle with step(), done(), fail() and an AbortSignal. */
function start({ kind, title, sessionId = null, cancellable = true }) {
  const job = { id: newId('job'), kind, title: String(title || kind).slice(0, 160), sessionId, status: 'running', startedAt: now(), steps: [] };
  jobs.set(job.id, job);
  const controller = new AbortController();
  if (cancellable) controllers.set(job.id, controller);
  trim();
  publish('job.created', job);
  const handle = {
    id: job.id, job, signal: controller.signal,
    /** Adds a running step; returns {update, done, fail}. */
    step(label, detail = '', extra = {}) {
      const step = { id: 's' + (job.steps.length + 1), label: String(label).slice(0, 200), detail: String(detail || '').slice(0, 2000), status: 'running', startedAt: now(), ...extra };
      // Only one step runs at a time in a job: finish the previous one if it was left open.
      for (const s of job.steps) if (s.status === 'running' && !s.waiting) { s.status = 'done'; s.finishedAt = now(); }
      job.steps.push(step);
      publish('job.updated', job);
      const api = {
        step,
        update(fields) { Object.assign(step, fields); if (fields.detail) step.detail = String(fields.detail).slice(0, 2000); publish('job.updated', job); return api; },
        done(detail) { step.status = 'done'; step.waiting = false; step.finishedAt = now(); if (detail != null) step.detail = String(detail).slice(0, 2000); publish('job.updated', job); return api; },
        fail(error) { step.status = 'failed'; step.waiting = false; step.finishedAt = now(); step.detail = String(error && error.message || error).slice(0, 2000); publish('job.updated', job); return api; },
      };
      return api;
    },
    note(label, detail = '') { return handle.step(label, detail).done(); },
    done(result) {
      if (job.status !== 'running') return;
      for (const s of job.steps) if (s.status === 'running') { s.status = 'done'; s.finishedAt = now(); }
      job.status = 'done'; job.finishedAt = now(); if (result) job.result = result; controllers.delete(job.id); publish('job.finished', job);
    },
    fail(error) {
      if (job.status !== 'running') return;
      const cancelled = controller.signal.aborted;
      for (const s of job.steps) if (s.status === 'running') { s.status = cancelled ? 'cancelled' : 'failed'; s.finishedAt = now(); }
      job.status = cancelled ? 'cancelled' : 'failed'; job.error = cancelled ? 'Cancelled' : String(error && error.message || error).slice(0, 1000);
      job.finishedAt = now(); controllers.delete(job.id); publish('job.finished', job);
    },
  };
  return handle;
}

function cancel(id) {
  const c = controllers.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

function trim() {
  const finished = [...jobs.values()].filter(j => j.status !== 'running');
  while (jobs.size > MAX_RECENT && finished.length) jobs.delete(finished.shift().id);
}

/** Jobs for the Activity drawer: running first, then the most recent. */
function list({ sessionId = null, limit = 40 } = {}) {
  let all = [...jobs.values()].map(publicJob);
  if (storeRef) {
    const seen = new Set(all.map(j => j.id));
    for (const j of storeRef.all('chatJobs')) if (!seen.has(j.id)) all.push(j);
  }
  if (sessionId) all = all.filter(j => j.sessionId === sessionId);
  all.sort((a, b) => (a.status === 'running') - (b.status === 'running') || String(a.startedAt).localeCompare(String(b.startedAt)));
  return all.reverse().slice(0, limit);
}

function get(id) { const j = jobs.get(id); return j ? publicJob(j) : (storeRef && storeRef.get('chatJobs', id)) || null; }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** A job that was running when NOVA quit cannot finish; mark it so. */
function recoverInterrupted() {
  if (!storeRef) return;
  for (const j of storeRef.all('chatJobs')) {
    if (j.status !== 'running') continue;
    j.status = 'interrupted'; j.error = 'Maataa was closed while this was running.'; j.finishedAt = now();
    j.steps = (j.steps || []).map(s => s.status === 'running' ? { ...s, status: 'cancelled' } : s);
    storeRef.put('chatJobs', j);
  }
  // Keep the store small: the newest 300 jobs.
  const all = storeRef.all('chatJobs').sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const j of all.slice(300)) storeRef.delete('chatJobs', j.id);
}

function _reset() { jobs.clear(); controllers.clear(); listeners.clear(); storeRef = null; }

module.exports = { configure, start, cancel, list, get, subscribe, _reset };
