'use strict';
/* ===========================================================================
 * NOVA Runtime — storage layer
 *
 * Real SQLite (Node's built-in node:sqlite, no native compile, no npm
 * install) standing in for the frontend's old IndexedDB object stores.
 * Every store from the frontend's STORE_NAMES list gets one SQLite table,
 * keyed by the same `id` the frontend already uses (IndexedDB's keyPath:'id'
 * contract carries over unchanged). Each row is stored as a JSON blob
 * alongside its id, because the 17 stores have 17 different shapes and a
 * real per-column schema per store is Phase-2-or-later work, not something
 * worth blocking Phase 1 on. What actually changes in Phase 1 is that the
 * data is now durable, inspectable (`sqlite3 data/nova.db`), and shared
 * across process restarts — not where each field lives inside the row.
 * ========================================================================= */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const STORE_NAMES = [
  'sessions', 'models', 'modelProfiles', 'modelQualifications', 'knowledgeCollections', 'knowledgeDocuments',
  'knowledgeChunks', 'automations', 'automationRuns', 'evaluations', 'preferences',
  'runtimeEvents', 'skills', 'mcpServers', 'agents', 'workflows', 'workflowRuns', 'executions', 'collectionRuns', 'collectorEvidence', 'venueObservations',
  'workspaceRoots', 'workspaceReports', 'workspacePlans', 'workspacePlanningAttempts', 'workspaceChanges', 'workspaceChangeBatches', 'workspaceRuns', 'workspaceGitDrafts', 'workspaceGitActions', 'workspacePermissions', 'securityBackups',
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'nova.db');
  const db = new DatabaseSync(dbPath);
  // WAL needs a shared-memory (-shm) file plus real mmap'd locking between
  // readers/writers — several network and FUSE-backed mounts (sshfs,
  // rclone mounts, some bind-mount bridges) don't support that and WAL
  // fails outright with a generic "disk I/O error" on the very first
  // write, which otherwise looks indistinguishable from a corrupt/missing
  // database. Falling back to DELETE (SQLite's own default rollback
  // journal) keeps every write just as durable and ACID — it just loses
  // WAL's multi-reader concurrency, which a single local backend process
  // barely exercises anyway. Real fallback, not a silently weaker mode.
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (e) {
    console.warn(`[nova-runtime] WAL journal mode unavailable at ${dbPath} (${e.message}) — falling back to DELETE journal mode. This usually means the data directory is on a network or FUSE-backed mount; point DATA_DIR at local disk if you want WAL's concurrency back.`);
    db.exec('PRAGMA journal_mode = DELETE;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of STORE_NAMES) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS store_${name} (
         id TEXT PRIMARY KEY,
         data TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );`
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS browser_pages (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT NOT NULL,
    final_url TEXT NOT NULL, screenshot_path TEXT, sha256 TEXT,
    policy_id TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, status TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS browser_actions (
    id TEXT PRIMARY KEY, page_id TEXT, kind TEXT NOT NULL,
    selector_hash TEXT, payload_hash TEXT, result TEXT NOT NULL,
    policy_id TEXT, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS browser_egress (
    id TEXT PRIMARY KEY, page_id TEXT, domain TEXT NOT NULL,
    allowed INTEGER NOT NULL, reason TEXT NOT NULL, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS egress_allowlist (
    domain TEXT PRIMARY KEY, added_at TEXT NOT NULL, added_by TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS global_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.prepare(`INSERT OR IGNORE INTO global_state (key,value,updated_at) VALUES ('global_halt','0',?)`).run(new Date().toISOString());
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    payload_json TEXT NOT NULL, result_json TEXT,
    created_at TEXT NOT NULL, started_at TEXT, heartbeat_at TEXT, timeout_at TEXT,
    run_at TEXT NOT NULL, timeout_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT, error TEXT, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_state_run_at ON jobs(state, run_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS job_events (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL,
    payload_json TEXT, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    effect TEXT NOT NULL, scope TEXT, conditions_json TEXT,
    expires_at TEXT, revoked_at TEXT,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_subject ON policies(subject_type, subject_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_resource ON policies(resource_type, resource_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS policy_decisions (
    id TEXT PRIMARY KEY, policy_id TEXT,
    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    decision TEXT NOT NULL, reason TEXT NOT NULL,
    inputs_hash TEXT NOT NULL, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_decisions_policy ON policy_decisions(policy_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policy_decisions_ts ON policy_decisions(timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS green_commits (
    domain TEXT PRIMARY KEY, sha TEXT NOT NULL, meta_json TEXT,
    set_at TEXT NOT NULL, set_by TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS quarantines (
    id TEXT PRIMARY KEY, domain TEXT NOT NULL, reason TEXT NOT NULL,
    diff TEXT, files_json TEXT, task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT,
    resolution_note TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantines_domain_status ON quarantines(domain, status);`);
  db.exec(`CREATE TABLE IF NOT EXISTS rollback_events (
    id TEXT PRIMARY KEY, domain TEXT NOT NULL, reason TEXT NOT NULL,
    from_sha TEXT, to_sha TEXT, task_id TEXT, quarantine_id TEXT,
    outcome TEXT NOT NULL, error TEXT, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rollback_events_domain_ts ON rollback_events(domain, timestamp);`);

  return { db, dbPath };
}

function assertStore(name) {
  if (!STORE_NAMES.includes(name)) {
    const err = new Error(`Unknown store "${name}"`);
    err.statusCode = 404;
    throw err;
  }
}

/** Thin, synchronous CRUD — node:sqlite's API is synchronous (it's a local
 *  file, there is nothing worth making async here), which is also exactly
 *  what the frontend's old idbPut (fire-and-forget, no await) expects: the
 *  write lands before the HTTP response does. */
class Store {
  constructor(db) {
    this.db = db;
    this._stmtCache = new Map();
  }
  _stmt(sql) {
    let s = this._stmtCache.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmtCache.set(sql, s); }
    return s;
  }
  all(name) {
    assertStore(name);
    const rows = this._stmt(`SELECT data FROM store_${name} ORDER BY updated_at ASC`).all();
    return rows.map(r => JSON.parse(r.data));
  }
  /** Real cursor pagination (Phase 5) — most-recent-first, using the
   *  updated_at column SQLite already indexes as the primary key's
   *  neighbor. Replaces the frontend's old approach of fetching every row
   *  via all() and then silently truncating its in-memory copy to a fixed
   *  count: that cap never touched the actual stored rows (every row was
   *  always durable in SQLite), it just made the client's view of history
   *  quietly diverge from what's really there. This lets a view page back
   *  through the *real* full table instead. */
  page(name, { limit = 50, beforeUpdatedAt = null } = {}) {
    assertStore(name);
    limit = Math.max(1, Math.min(500, Number(limit) || 50));
    const rows = beforeUpdatedAt
      ? this._stmt(`SELECT id, data, updated_at FROM store_${name} WHERE updated_at < ? ORDER BY updated_at DESC LIMIT ?`).all(beforeUpdatedAt, limit)
      : this._stmt(`SELECT id, data, updated_at FROM store_${name} ORDER BY updated_at DESC LIMIT ?`).all(limit);
    const total = this._stmt(`SELECT COUNT(*) AS c FROM store_${name}`).get().c;
    return {
      rows: rows.map(r => JSON.parse(r.data)),
      nextBefore: rows.length === limit ? rows[rows.length - 1].updated_at : null,
      total,
    };
  }
  get(name, id) {
    assertStore(name);
    const row = this._stmt(`SELECT data FROM store_${name} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }
  put(name, value) {
    assertStore(name);
    if (!value || typeof value !== 'object' || !value.id) {
      const err = new Error('Value must be an object with an "id" field');
      err.statusCode = 400;
      throw err;
    }
    this._stmt(
      `INSERT INTO store_${name} (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(value.id, JSON.stringify(value), new Date().toISOString());
    return value;
  }
  delete(name, id) {
    assertStore(name);
    this._stmt(`DELETE FROM store_${name} WHERE id = ?`).run(id);
  }
  clear(name) {
    assertStore(name);
    this._stmt(`DELETE FROM store_${name}`).run();
  }
  clearAll() {
    for (const name of STORE_NAMES) this.clear(name);
  }

  browserInsertPage(row) { this._stmt('INSERT INTO browser_pages (id,agent_id,url,final_url,screenshot_path,sha256,policy_id,opened_at,closed_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.agentId,row.url,row.finalUrl,row.screenshotPath || null,row.sha256 || null,row.policyId,row.openedAt,null,row.status); }
  browserUpdatePage(id, fields) { const old=this._stmt('SELECT * FROM browser_pages WHERE id=?').get(id); if (!old) return null; const row={...old,...fields}; this._stmt('UPDATE browser_pages SET final_url=?,screenshot_path=?,sha256=?,closed_at=?,status=? WHERE id=?').run(row.final_url,row.screenshot_path,row.sha256,row.closed_at,row.status,id); return row; }
  browserPages(agentId) { return this._stmt('SELECT * FROM browser_pages WHERE agent_id=? ORDER BY opened_at ASC').all(agentId); }
  browserAction(row) { this._stmt('INSERT INTO browser_actions (id,page_id,kind,selector_hash,payload_hash,result,policy_id,timestamp) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.pageId || null,row.kind,row.selectorHash || null,row.payloadHash || null,row.result,row.policyId || null,row.timestamp); }
  browserEgress(row) { this._stmt('INSERT INTO browser_egress (id,page_id,domain,allowed,reason,timestamp) VALUES (?,?,?,?,?,?)').run(row.id,row.pageId || null,row.domain,row.allowed ? 1 : 0,row.reason,row.timestamp); }
  allowEgress(domain, addedBy='system') { this._stmt('INSERT OR REPLACE INTO egress_allowlist (domain,added_at,added_by) VALUES (?,?,?)').run(String(domain).toLowerCase(),new Date().toISOString(),addedBy); }
  egressAllowed(domain) { return Boolean(this._stmt('SELECT 1 FROM egress_allowlist WHERE domain=?').get(String(domain).toLowerCase())); }
  getGlobalHalt() { const row=this._stmt("SELECT value FROM global_state WHERE key='global_halt'").get(); return row ? row.value : '0'; }
  setGlobalHalt(value) { this._stmt("UPDATE global_state SET value=?,updated_at=? WHERE key='global_halt'").run(String(value),new Date().toISOString()); }
  jobsInsert(row) { this._stmt('INSERT INTO jobs (id,kind,state,payload_json,result_json,created_at,started_at,heartbeat_at,timeout_at,run_at,timeout_ms,attempts,max_attempts,parent_id,error,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.kind,row.state,row.payload_json,row.result_json||null,row.created_at,row.started_at||null,row.heartbeat_at||null,row.timeout_at||null,row.run_at,row.timeout_ms,row.attempts,row.max_attempts,row.parent_id||null,row.error||null,row.ended_at||null); return this.jobsGet(row.id); }
  jobsGet(id) { return this._stmt('SELECT * FROM jobs WHERE id=?').get(id) || null; }
  jobsUpdate(id, patch) { const cur=this.jobsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE jobs SET kind=?,state=?,payload_json=?,result_json=?,started_at=?,heartbeat_at=?,timeout_at=?,run_at=?,timeout_ms=?,attempts=?,max_attempts=?,parent_id=?,error=?,ended_at=? WHERE id=?').run(n.kind,n.state,n.payload_json,n.result_json,n.started_at,n.heartbeat_at,n.timeout_at,n.run_at,n.timeout_ms,n.attempts,n.max_attempts,n.parent_id,n.error,n.ended_at,id); return this.jobsGet(id); }
  jobsListByState(state) { return this._stmt('SELECT * FROM jobs WHERE state=? ORDER BY created_at ASC').all(state); }
  jobsClaimNext(n) { const nowStr=new Date().toISOString(); const candidates=this._stmt('SELECT id FROM jobs WHERE state=? AND run_at<=? ORDER BY run_at ASC LIMIT ?').all('queued',nowStr,n); const claimed=[]; for (const c of candidates) { const info=this._stmt('UPDATE jobs SET state=?, started_at=? WHERE id=? AND state=?').run('running',nowStr,c.id,'queued'); if (info.changes===1) claimed.push(this.jobsGet(c.id)); } return claimed; }
  jobsFindTimedOut() { const nowStr=new Date().toISOString(); return this._stmt('SELECT * FROM jobs WHERE state=? AND timeout_at IS NOT NULL AND timeout_at < ?').all('running',nowStr); }
  jobsInsertEvent(row) { this._stmt('INSERT INTO job_events (id,job_id,kind,payload_json,timestamp) VALUES (?,?,?,?,?)').run(row.id,row.job_id,row.kind,row.payload_json||null,row.timestamp); return row; }
  jobsListEvents(jobId) { return this._stmt('SELECT * FROM job_events WHERE job_id=? ORDER BY timestamp ASC').all(jobId); }
  policiesInsert(row) { this._stmt('INSERT INTO policies (id,subject_type,subject_id,resource_type,resource_id,effect,scope,conditions_json,expires_at,revoked_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.subject_type,row.subject_id,row.resource_type,row.resource_id,row.effect,row.scope||null,row.conditions_json||null,row.expires_at||null,row.revoked_at||null,row.created_at,row.created_by); return this.policiesGet(row.id); }
  policiesGet(id) { return this._stmt('SELECT * FROM policies WHERE id=?').get(id) || null; }
  policiesUpdate(id, patch) { const cur=this.policiesGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE policies SET subject_type=?,subject_id=?,resource_type=?,resource_id=?,effect=?,scope=?,conditions_json=?,expires_at=?,revoked_at=? WHERE id=?').run(n.subject_type,n.subject_id,n.resource_type,n.resource_id,n.effect,n.scope,n.conditions_json,n.expires_at,n.revoked_at,id); return this.policiesGet(id); }
  policiesList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.subject_type){c.push('subject_type=?');a.push(filter.subject_type);} if(filter.subject_id){c.push('subject_id=?');a.push(filter.subject_id);} if(filter.resource_type){c.push('resource_type=?');a.push(filter.resource_type);} if(filter.resource_id){c.push('resource_id=?');a.push(filter.resource_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM policies'+w+' ORDER BY created_at ASC').all(...a); }
  policyDecisionsInsert(row) { this._stmt('INSERT INTO policy_decisions (id,policy_id,subject_type,subject_id,resource_type,resource_id,decision,reason,inputs_hash,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.policy_id||null,row.subject_type,row.subject_id,row.resource_type,row.resource_id,row.decision,row.reason,row.inputs_hash,row.timestamp); return row; }
  policyDecisionsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.policy_id){c.push('policy_id=?');a.push(filter.policy_id);} if(filter.subject_id){c.push('subject_id=?');a.push(filter.subject_id);} if(filter.decision){c.push('decision=?');a.push(filter.decision);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM policy_decisions'+w+' ORDER BY timestamp ASC').all(...a); }
  policyDecisionsCountSince(policyId, sinceIso) { const r=this._stmt('SELECT COUNT(*) AS n FROM policy_decisions WHERE policy_id=? AND decision=? AND timestamp>=?').get(policyId,'allow',sinceIso); return r?r.n:0; }
  greenCommitsSet(row) { this._stmt('INSERT INTO green_commits (domain,sha,meta_json,set_at,set_by) VALUES (?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET sha=excluded.sha, meta_json=excluded.meta_json, set_at=excluded.set_at, set_by=excluded.set_by').run(row.domain,row.sha,row.meta_json||null,row.set_at,row.set_by); return this.greenCommitsGet(row.domain); }
  greenCommitsGet(domain) { return this._stmt('SELECT * FROM green_commits WHERE domain=?').get(domain) || null; }
  greenCommitsList() { return this._stmt('SELECT * FROM green_commits ORDER BY domain ASC').all(); }
  greenCommitsClear(domain) { this._stmt('DELETE FROM green_commits WHERE domain=?').run(domain); return { ok: true }; }
  quarantinesInsert(row) { this._stmt('INSERT INTO quarantines (id,domain,reason,diff,files_json,task_id,status,created_at,resolved_at,resolved_by,resolution_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.domain,row.reason,row.diff||null,row.files_json||null,row.task_id||null,row.status,row.created_at,row.resolved_at||null,row.resolved_by||null,row.resolution_note||null); return this.quarantinesGet(row.id); }
  quarantinesGet(id) { return this._stmt('SELECT * FROM quarantines WHERE id=?').get(id) || null; }
  quarantinesUpdate(id, patch) { const cur=this.quarantinesGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE quarantines SET status=?, resolved_at=?, resolved_by=?, resolution_note=? WHERE id=?').run(n.status,n.resolved_at,n.resolved_by,n.resolution_note,id); return this.quarantinesGet(id); }
  quarantinesList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.domain){c.push('domain=?');a.push(filter.domain);} if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM quarantines'+w+' ORDER BY created_at ASC').all(...a); }
  rollbackEventsInsert(row) { this._stmt('INSERT INTO rollback_events (id,domain,reason,from_sha,to_sha,task_id,quarantine_id,outcome,error,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.domain,row.reason,row.from_sha||null,row.to_sha||null,row.task_id||null,row.quarantine_id||null,row.outcome,row.error||null,row.timestamp); return row; }
  rollbackEventsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.domain){c.push('domain=?');a.push(filter.domain);} if(filter.outcome){c.push('outcome=?');a.push(filter.outcome);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM rollback_events'+w+' ORDER BY timestamp ASC').all(...a); }
}

module.exports = { STORE_NAMES, openDb, Store };
