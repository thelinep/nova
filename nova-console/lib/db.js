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
  'neuronBlueprints', 'neuronRuns', 'neuronArtifacts',
  'backgroundJobs', 'artifactEvaluations', 'connectorProfiles', 'secretRecords', 'releaseEvidence',
  'runtimeEvents', 'skills', 'mcpServers', 'agents', 'workflows', 'workflowRuns', 'executions', 'collectionRuns', 'collectorEvidence', 'venueObservations',
  'workspaceRoots', 'workspaceReports', 'workspacePlans', 'workspacePlanningAttempts', 'workspaceChanges', 'workspaceChangeBatches', 'workspaceProjects', 'workspaceLoops', 'workspaceRuns', 'media', 'generationJobs', 'skillOutputs', 'boards', 'timelines', 'workspaceGitDrafts', 'workspaceGitActions', 'workspacePermissions', 'securityBackups', 'chatSources', 'chatJobs', 'userMemory', 'characters', 'devices', 'executionContracts', 'aaiEvidence',
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
  db.exec(`CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    window TEXT NOT NULL, limits_json TEXT NOT NULL,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, revoked_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_budgets_subject ON budgets(subject_type, subject_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS budget_consumption (
    id TEXT PRIMARY KEY, budget_id TEXT,
    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    kind TEXT NOT NULL, amount REAL NOT NULL, ref_id TEXT,
    timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_budget_consumption_subject ON budget_consumption(subject_type, subject_id, timestamp);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_budget_consumption_budget ON budget_consumption(budget_id, timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS kill_switch_events (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, operator TEXT NOT NULL,
    reason TEXT NOT NULL, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kill_switch_events_ts ON kill_switch_events(timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_lineage (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, domain TEXT NOT NULL,
    agent_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
    payload_json TEXT NOT NULL, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autonomy_lineage_run ON autonomy_lineage(run_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autonomy_lineage_ts ON autonomy_lineage(timestamp);`);
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_patches (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, domain TEXT NOT NULL,
    status TEXT NOT NULL, branch TEXT, files_json TEXT,
    diff_hash TEXT, sandbox_path TEXT, test_summary_json TEXT,
    reason TEXT, error TEXT, created_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_patches_run ON workspace_patches(run_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS constellation_runs (
    id TEXT PRIMARY KEY, problem_hash TEXT NOT NULL,
    provider_count INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
    winner_id TEXT, status TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_constellation_runs_started ON constellation_runs(started_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS constellation_candidates (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    code TEXT, error TEXT, created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_constellation_candidates_run ON constellation_candidates(run_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS constellation_rounds (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
    group_index INTEGER NOT NULL, entrants_json TEXT NOT NULL,
    winner_id TEXT NOT NULL, votes_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_constellation_rounds_run ON constellation_rounds(run_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS test_synthesis_runs (
    id TEXT PRIMARY KEY, problem_hash TEXT NOT NULL,
    candidate_hash TEXT NOT NULL, status TEXT NOT NULL,
    iterations INTEGER NOT NULL DEFAULT 0, passed INTEGER, failed INTEGER,
    test_code TEXT, run_json TEXT,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_test_synthesis_started ON test_synthesis_runs(started_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_vote_runs (
    id TEXT PRIMARY KEY, candidate_count INTEGER NOT NULL,
    input_count INTEGER NOT NULL, winner_id TEXT,
    cluster_count INTEGER NOT NULL, clusters_json TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_vote_started ON semantic_vote_runs(started_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS clover_verifications (
    id TEXT PRIMARY KEY, problem_hash TEXT NOT NULL,
    candidate_hash TEXT NOT NULL, status TEXT NOT NULL,
    phase TEXT, consistency_ok INTEGER, proof_ok INTEGER,
    proof_attempts INTEGER, detail TEXT,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_clover_started ON clover_verifications(started_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS dafny_pro_runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL,
    error TEXT, spec_hash TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dafny_pro_started ON dafny_pro_runs(started_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS dafny_pro_attempts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    verified INTEGER NOT NULL, error_count INTEGER NOT NULL,
    annotations_json TEXT, rejected_reason TEXT, created_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dafny_pro_attempts_run ON dafny_pro_attempts(run_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS correctness_pipeline_runs (
    id TEXT PRIMARY KEY, problem_hash TEXT NOT NULL,
    status TEXT NOT NULL, stage TEXT, detail TEXT,
    constellation_run_id TEXT, constellation_winner_id TEXT,
    clover_run_id TEXT,
    consistency_ok INTEGER, proof_ok INTEGER,
    started_at TEXT NOT NULL, ended_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_correctness_pipeline_started ON correctness_pipeline_runs(started_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_correctness_pipeline_constellation ON correctness_pipeline_runs(constellation_run_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS connector_profiles (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    config_json TEXT NOT NULL, secret_refs_json TEXT,
    scopes_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, revoked_at TEXT
  );`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_profiles_kind_name ON connector_profiles(kind, name) WHERE revoked_at IS NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_connector_profiles_kind ON connector_profiles(kind, revoked_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS secret_records (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    ciphertext_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, tag_b64 TEXT NOT NULL,
    metadata_json TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    rotated_at TEXT, revoked_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_secret_records_name ON secret_records(name, revoked_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS connector_action_requests (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, connector_kind TEXT NOT NULL,
    operation TEXT NOT NULL, args_json TEXT NOT NULL,
    status TEXT NOT NULL, policy_id TEXT,
    requested_at TEXT NOT NULL, requested_by TEXT NOT NULL,
    resolved_at TEXT, resolved_by TEXT, resolution_note TEXT,
    executed_at TEXT, result_json TEXT, error TEXT,
    expires_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conn_action_status ON connector_action_requests(status, requested_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conn_action_profile ON connector_action_requests(profile_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_registry (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL, description TEXT,
    instructions_json TEXT NOT NULL,
    model_preference_json TEXT,
    allowed_tools_json TEXT NOT NULL,
    memory_scope TEXT NOT NULL DEFAULT 'private',
    supervisor_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    revoked_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_registry_role ON agent_registry(role, revoked_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_registry_supervisor ON agent_registry(supervisor_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL, scope TEXT NOT NULL,
    content_json TEXT NOT NULL, tags_json TEXT NOT NULL,
    source_ref TEXT, confidence REAL,
    created_at TEXT NOT NULL, expires_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory(agent_id, kind);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope, created_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    state TEXT NOT NULL,
    creator_id TEXT NOT NULL, assignee_id TEXT,
    parent_task_id TEXT, handoff_count INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT, result_json TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, ended_at TEXT, expires_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_assignee ON agent_tasks(assignee_id, state);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_creator ON agent_tasks(creator_id, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor_id TEXT,
    from_assignee TEXT, to_assignee TEXT,
    reason TEXT, payload_json TEXT,
    timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_events_task ON agent_task_events(task_id, timestamp);`);

  // Idempotent column migration: job_id links a task to its running job.
  try {
    const cols = db.prepare("PRAGMA table_info(agent_tasks)").all();
    if (!cols.some((c) => c.name === 'job_id')) {
      db.exec("ALTER TABLE agent_tasks ADD COLUMN job_id TEXT");
    }
  } catch { /* best-effort */ }

  db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_bindings (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL, tool_id TEXT NOT NULL,
    operations_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    expires_at TEXT, revoked_at TEXT
  );`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_unique ON agent_tool_bindings(agent_id, kind, tool_id) WHERE revoked_at IS NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tool_agent ON agent_tool_bindings(agent_id, enabled, revoked_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tool_lookup ON agent_tool_bindings(kind, tool_id, revoked_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_escalations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    escalator_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
    state TEXT NOT NULL, summary TEXT NOT NULL,
    detail_json TEXT,
    tool_kind TEXT, tool_id TEXT, tool_operation TEXT,
    parent_escalation_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    decided_at TEXT, expires_at TEXT, decision_note TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_esc_reviewer ON agent_escalations(reviewer_id, state, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_esc_escalator ON agent_escalations(escalator_id, created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_esc_parent ON agent_escalations(parent_escalation_id);`);

  db.exec(`CREATE TABLE IF NOT EXISTS agent_escalation_events (
    id TEXT PRIMARY KEY, escalation_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor_id TEXT,
    reason TEXT, payload_json TEXT, timestamp TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_esc_events ON agent_escalation_events(escalation_id, timestamp);`);

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
  egressAllowlist() { return this._stmt('SELECT * FROM egress_allowlist ORDER BY domain ASC').all(); }
  removeEgress(domain) { this._stmt('DELETE FROM egress_allowlist WHERE domain=?').run(String(domain).toLowerCase()); }
  browserRecentPages(limit=60) { return this._stmt('SELECT * FROM browser_pages ORDER BY opened_at DESC LIMIT ?').all(limit); }
  browserRecentActions(limit=60) { return this._stmt('SELECT a.*, p.agent_id, p.final_url FROM browser_actions a LEFT JOIN browser_pages p ON p.id=a.page_id ORDER BY a.timestamp DESC LIMIT ?').all(limit); }
  browserRecentEgress(limit=60, allowed=null) { return allowed==null ? this._stmt('SELECT * FROM browser_egress ORDER BY timestamp DESC LIMIT ?').all(limit) : this._stmt('SELECT * FROM browser_egress WHERE allowed=? ORDER BY timestamp DESC LIMIT ?').all(allowed?1:0, limit); }
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
  budgetsInsert(row) { this._stmt('INSERT INTO budgets (id,subject_type,subject_id,window,limits_json,created_at,created_by,revoked_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.subject_type,row.subject_id,row.window,row.limits_json,row.created_at,row.created_by,row.revoked_at||null); return this.budgetsGet(row.id); }
  budgetsGet(id) { return this._stmt('SELECT * FROM budgets WHERE id=?').get(id) || null; }
  budgetsUpdate(id, patch) { const cur=this.budgetsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE budgets SET limits_json=?, revoked_at=? WHERE id=?').run(n.limits_json,n.revoked_at,id); return this.budgetsGet(id); }
  budgetsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.subject_type){c.push('subject_type=?');a.push(filter.subject_type);} if(filter.subject_id){c.push('subject_id=?');a.push(filter.subject_id);} if(filter.active){c.push('revoked_at IS NULL');} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM budgets'+w+' ORDER BY created_at ASC').all(...a); }
  budgetsRevoke(id) { return this.budgetsUpdate(id, { revoked_at: new Date().toISOString() }); }
  budgetConsumptionInsert(row) { this._stmt('INSERT INTO budget_consumption (id,budget_id,subject_type,subject_id,kind,amount,ref_id,timestamp) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.budget_id||null,row.subject_type,row.subject_id,row.kind,row.amount,row.ref_id||null,row.timestamp); return row; }
  budgetConsumptionSum(subjectType, subjectId, kind, sinceIso) { const r=this._stmt('SELECT COALESCE(SUM(amount),0) AS total FROM budget_consumption WHERE subject_type=? AND subject_id=? AND kind=? AND timestamp>=?').get(subjectType,subjectId,kind,sinceIso); return r?r.total:0; }
  budgetConsumptionList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.subject_type){c.push('subject_type=?');a.push(filter.subject_type);} if(filter.subject_id){c.push('subject_id=?');a.push(filter.subject_id);} if(filter.budget_id){c.push('budget_id=?');a.push(filter.budget_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM budget_consumption'+w+' ORDER BY timestamp ASC').all(...a); }
  killSwitchEventsInsert(row) { this._stmt('INSERT INTO kill_switch_events (id,action,operator,reason,timestamp) VALUES (?,?,?,?,?)').run(row.id,row.action,row.operator,row.reason,row.timestamp); return row; }
  killSwitchEventsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.action){c.push('action=?');a.push(filter.action);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM kill_switch_events'+w+' ORDER BY timestamp ASC').all(...a); }
  auditAppend(row) { const { id, action, timestamp, ...rest } = row; this._stmt('INSERT INTO autonomy_lineage (id,run_id,domain,agent_id,status,reason,payload_json,timestamp) VALUES (?,?,?,?,?,?,?,?)').run(id, (rest.run_id)||'unknown', (rest.domain)||'unknown', (rest.agent_id)||'system', (rest.status)||action||'event', (rest.reason)||null, JSON.stringify(rest), timestamp||new Date().toISOString()); return id; }
  autonomyLineageList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.run_id){c.push('run_id=?');a.push(filter.run_id);} if(filter.domain){c.push('domain=?');a.push(filter.domain);} if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM autonomy_lineage'+w+' ORDER BY timestamp ASC').all(...a); }
  workspacePatchesInsert(row) { this._stmt('INSERT INTO workspace_patches (id,run_id,domain,status,branch,files_json,diff_hash,sandbox_path,test_summary_json,reason,error,created_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.run_id,row.domain,row.status,row.branch||null,row.files_json||null,row.diff_hash||null,row.sandbox_path||null,row.test_summary_json||null,row.reason||null,row.error||null,row.created_at,row.ended_at||null); return this.workspacePatchesGet(row.id); }
  workspacePatchesGet(id) { return this._stmt('SELECT * FROM workspace_patches WHERE id=?').get(id) || null; }
  workspacePatchesUpdate(id, patch) { const cur=this.workspacePatchesGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE workspace_patches SET status=?,branch=?,files_json=?,diff_hash=?,sandbox_path=?,test_summary_json=?,reason=?,error=?,ended_at=? WHERE id=?').run(n.status,n.branch,n.files_json,n.diff_hash,n.sandbox_path,n.test_summary_json,n.reason,n.error,n.ended_at,id); return this.workspacePatchesGet(id); }
  workspacePatchesList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.run_id){c.push('run_id=?');a.push(filter.run_id);} if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM workspace_patches'+w+' ORDER BY created_at ASC').all(...a); }


  constellationRunsInsert(row) { this._stmt('INSERT INTO constellation_runs (id,problem_hash,provider_count,candidate_count,winner_id,status,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.problem_hash,row.provider_count,row.candidate_count,row.winner_id||null,row.status,row.started_at,row.ended_at||null); return this.constellationRunsGet(row.id); }
  constellationRunsGet(id) { return this._stmt('SELECT * FROM constellation_runs WHERE id=?').get(id) || null; }
  constellationRunsUpdate(id, patch) { const cur=this.constellationRunsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE constellation_runs SET candidate_count=?, winner_id=?, status=?, ended_at=? WHERE id=?').run(n.candidate_count,n.winner_id,n.status,n.ended_at,id); return this.constellationRunsGet(id); }
  constellationRunsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM constellation_runs'+w+' ORDER BY started_at ASC').all(...a); }
  constellationCandidatesInsert(row) { this._stmt('INSERT INTO constellation_candidates (id,run_id,provider_id,code,error,created_at) VALUES (?,?,?,?,?,?)').run(row.id,row.run_id,row.provider_id,row.code||null,row.error||null,row.created_at); return row; }
  constellationCandidatesList(runId) { return this._stmt('SELECT * FROM constellation_candidates WHERE run_id=? ORDER BY created_at ASC').all(runId); }
  constellationRoundsInsert(row) { this._stmt('INSERT INTO constellation_rounds (id,run_id,round,group_index,entrants_json,winner_id,votes_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.run_id,row.round,row.group_index,row.entrants_json,row.winner_id,row.votes_json,row.created_at); return row; }
  constellationRoundsList(runId) { return this._stmt('SELECT * FROM constellation_rounds WHERE run_id=? ORDER BY round ASC, group_index ASC').all(runId); }

  testSynthesisRunsInsert(row) { this._stmt('INSERT INTO test_synthesis_runs (id,problem_hash,candidate_hash,status,iterations,passed,failed,test_code,run_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.problem_hash,row.candidate_hash,row.status,row.iterations||0,row.passed==null?null:row.passed,row.failed==null?null:row.failed,row.test_code||null,row.run_json||null,row.started_at,row.ended_at||null); return this.testSynthesisRunsGet(row.id); }
  testSynthesisRunsGet(id) { return this._stmt('SELECT * FROM test_synthesis_runs WHERE id=?').get(id) || null; }
  testSynthesisRunsUpdate(id, patch) { const cur=this.testSynthesisRunsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE test_synthesis_runs SET status=?,iterations=?,passed=?,failed=?,test_code=?,run_json=?,ended_at=? WHERE id=?').run(n.status,n.iterations,n.passed,n.failed,n.test_code,n.run_json,n.ended_at,id); return this.testSynthesisRunsGet(id); }
  testSynthesisRunsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM test_synthesis_runs'+w+' ORDER BY started_at ASC').all(...a); }
  semanticVoteRunsInsert(row) { this._stmt('INSERT INTO semantic_vote_runs (id,candidate_count,input_count,winner_id,cluster_count,clusters_json,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.candidate_count,row.input_count,row.winner_id||null,row.cluster_count,row.clusters_json,row.started_at,row.ended_at||null); return this.semanticVoteRunsGet(row.id); }
  semanticVoteRunsGet(id) { return this._stmt('SELECT * FROM semantic_vote_runs WHERE id=?').get(id) || null; }
  semanticVoteRunsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.winner_id){c.push('winner_id=?');a.push(filter.winner_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM semantic_vote_runs'+w+' ORDER BY started_at ASC').all(...a); }

  cloverVerificationsInsert(row) { this._stmt('INSERT INTO clover_verifications (id,problem_hash,candidate_hash,status,phase,consistency_ok,proof_ok,proof_attempts,detail,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.problem_hash,row.candidate_hash,row.status,row.phase||null,row.consistency_ok==null?null:row.consistency_ok,row.proof_ok==null?null:row.proof_ok,row.proof_attempts==null?null:row.proof_attempts,row.detail||null,row.started_at,row.ended_at||null); return this.cloverVerificationsGet(row.id); }
  cloverVerificationsGet(id) { return this._stmt('SELECT * FROM clover_verifications WHERE id=?').get(id) || null; }
  cloverVerificationsUpdate(id, patch) { const cur=this.cloverVerificationsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE clover_verifications SET status=?,phase=?,consistency_ok=?,proof_ok=?,proof_attempts=?,detail=?,ended_at=? WHERE id=?').run(n.status,n.phase,n.consistency_ok,n.proof_ok,n.proof_attempts,n.detail,n.ended_at,id); return this.cloverVerificationsGet(id); }
  cloverVerificationsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM clover_verifications'+w+' ORDER BY started_at ASC').all(...a); }
  dafnyProRunsInsert(row) { this._stmt('INSERT INTO dafny_pro_runs (id,status,attempts,error,spec_hash,started_at,ended_at) VALUES (?,?,?,?,?,?,?)').run(row.id,row.status,row.attempts||0,row.error||null,row.spec_hash,row.started_at,row.ended_at||null); return this.dafnyProRunsGet(row.id); }
  dafnyProRunsGet(id) { return this._stmt('SELECT * FROM dafny_pro_runs WHERE id=?').get(id) || null; }
  dafnyProRunsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM dafny_pro_runs'+w+' ORDER BY started_at ASC').all(...a); }
  dafnyProAttemptsInsert(row) { this._stmt('INSERT INTO dafny_pro_attempts (id,run_id,attempt,verified,error_count,annotations_json,rejected_reason,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,row.run_id,row.attempt,row.verified?1:0,row.error_count||0,row.annotations_json||null,row.rejected_reason||null,row.created_at); return row; }
  dafnyProAttemptsList(runId) { return this._stmt('SELECT * FROM dafny_pro_attempts WHERE run_id=? ORDER BY attempt ASC').all(runId); }

  correctnessPipelineRunsInsert(row) { this._stmt('INSERT INTO correctness_pipeline_runs (id,problem_hash,status,stage,detail,constellation_run_id,constellation_winner_id,clover_run_id,consistency_ok,proof_ok,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.problem_hash,row.status,row.stage||null,row.detail||null,row.constellation_run_id||null,row.constellation_winner_id||null,row.clover_run_id||null,row.consistency_ok==null?null:row.consistency_ok,row.proof_ok==null?null:row.proof_ok,row.started_at,row.ended_at||null); return this.correctnessPipelineRunsGet(row.id); }
  correctnessPipelineRunsGet(id) { return this._stmt('SELECT * FROM correctness_pipeline_runs WHERE id=?').get(id) || null; }
  correctnessPipelineRunsUpdate(id, patch) { const cur=this.correctnessPipelineRunsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE correctness_pipeline_runs SET status=?,stage=?,detail=?,constellation_run_id=?,constellation_winner_id=?,clover_run_id=?,consistency_ok=?,proof_ok=?,ended_at=? WHERE id=?').run(n.status,n.stage,n.detail,n.constellation_run_id,n.constellation_winner_id,n.clover_run_id,n.consistency_ok,n.proof_ok,n.ended_at,id); return this.correctnessPipelineRunsGet(id); }
  correctnessPipelineRunsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} if(filter.constellation_run_id){c.push('constellation_run_id=?');a.push(filter.constellation_run_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM correctness_pipeline_runs'+w+' ORDER BY started_at ASC').all(...a); }

  connectorProfilesInsert(row) { this._stmt('INSERT INTO connector_profiles (id,kind,name,config_json,secret_refs_json,scopes_json,enabled,created_at,created_by,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.kind,row.name,row.config_json,row.secret_refs_json||null,row.scopes_json,row.enabled?1:0,row.created_at,row.created_by,row.revoked_at||null); return this.connectorProfilesGet(row.id); }
  connectorProfilesGet(id) { return this._stmt('SELECT * FROM connector_profiles WHERE id=?').get(id) || null; }
  connectorProfilesUpdate(id, patch) { const cur=this.connectorProfilesGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE connector_profiles SET name=?, config_json=?, secret_refs_json=?, scopes_json=?, enabled=?, revoked_at=? WHERE id=?').run(n.name,n.config_json,n.secret_refs_json,n.scopes_json,n.enabled?1:0,n.revoked_at,id); return this.connectorProfilesGet(id); }
  connectorProfilesList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.kind){c.push('kind=?');a.push(filter.kind);} if(filter.enabled!=null){c.push('enabled=?');a.push(filter.enabled?1:0);} if(filter.active){c.push('revoked_at IS NULL');} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM connector_profiles'+w+' ORDER BY created_at ASC').all(...a); }
  connectorProfilesFindByName(kind,name) { return this._stmt('SELECT * FROM connector_profiles WHERE kind=? AND name=? AND revoked_at IS NULL').get(kind,name) || null; }

  secretRecordsInsert(row) { this._stmt('INSERT INTO secret_records (id,name,kind,ciphertext_b64,iv_b64,tag_b64,metadata_json,created_at,created_by,rotated_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.name,row.kind,row.ciphertext_b64,row.iv_b64,row.tag_b64,row.metadata_json||null,row.created_at,row.created_by,row.rotated_at||null,row.revoked_at||null); return this.secretRecordsGet(row.id); }
  secretRecordsGet(id) { return this._stmt('SELECT * FROM secret_records WHERE id=?').get(id) || null; }
  secretRecordsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.kind){c.push('kind=?');a.push(filter.kind);} if(filter.active){c.push('revoked_at IS NULL');} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM secret_records'+w+' ORDER BY created_at ASC').all(...a); }
  secretRecordsUpdate(id, patch) { const cur=this.secretRecordsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE secret_records SET name=?, ciphertext_b64=?, iv_b64=?, tag_b64=?, metadata_json=?, rotated_at=?, revoked_at=? WHERE id=?').run(n.name,n.ciphertext_b64,n.iv_b64,n.tag_b64,n.metadata_json,n.rotated_at,n.revoked_at,id); return this.secretRecordsGet(id); }

  connectorActionRequestsInsert(row) { this._stmt('INSERT INTO connector_action_requests (id,profile_id,connector_kind,operation,args_json,status,policy_id,requested_at,requested_by,resolved_at,resolved_by,resolution_note,executed_at,result_json,error,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.profile_id,row.connector_kind,row.operation,row.args_json,row.status,row.policy_id||null,row.requested_at,row.requested_by,row.resolved_at||null,row.resolved_by||null,row.resolution_note||null,row.executed_at||null,row.result_json||null,row.error||null,row.expires_at||null); return this.connectorActionRequestsGet(row.id); }
  connectorActionRequestsGet(id) { return this._stmt('SELECT * FROM connector_action_requests WHERE id=?').get(id) || null; }
  connectorActionRequestsUpdate(id, patch) { const cur=this.connectorActionRequestsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE connector_action_requests SET status=?, policy_id=?, resolved_at=?, resolved_by=?, resolution_note=?, executed_at=?, result_json=?, error=?, expires_at=? WHERE id=?').run(n.status,n.policy_id,n.resolved_at,n.resolved_by,n.resolution_note,n.executed_at,n.result_json,n.error,n.expires_at,id); return this.connectorActionRequestsGet(id); }
  connectorActionRequestsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.status){c.push('status=?');a.push(filter.status);} if(filter.profile_id){c.push('profile_id=?');a.push(filter.profile_id);} if(filter.operation){c.push('operation=?');a.push(filter.operation);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM connector_action_requests'+w+' ORDER BY requested_at ASC').all(...a); }

  agentRegistryInsert(row) { this._stmt('INSERT INTO agent_registry (id,name,role,description,instructions_json,model_preference_json,allowed_tools_json,memory_scope,supervisor_id,enabled,created_at,created_by,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.name,row.role,row.description||null,row.instructions_json,row.model_preference_json||null,row.allowed_tools_json,row.memory_scope,row.supervisor_id||null,row.enabled?1:0,row.created_at,row.created_by,row.revoked_at||null); return this.agentRegistryGet(row.id); }
  agentRegistryGet(id) { return this._stmt('SELECT * FROM agent_registry WHERE id=?').get(id) || null; }
  agentRegistryFindByName(name) { return this._stmt('SELECT * FROM agent_registry WHERE name=? AND revoked_at IS NULL').get(name) || null; }
  agentRegistryUpdate(id, patch) { const cur=this.agentRegistryGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE agent_registry SET name=?, role=?, description=?, instructions_json=?, model_preference_json=?, allowed_tools_json=?, memory_scope=?, supervisor_id=?, enabled=?, revoked_at=? WHERE id=?').run(n.name,n.role,n.description,n.instructions_json,n.model_preference_json,n.allowed_tools_json,n.memory_scope,n.supervisor_id,n.enabled?1:0,n.revoked_at,id); return this.agentRegistryGet(id); }
  agentRegistryList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.role){c.push('role=?');a.push(filter.role);} if(filter.enabled!=null){c.push('enabled=?');a.push(filter.enabled?1:0);} if(filter.active){c.push('revoked_at IS NULL');} if(filter.supervisor_id){c.push('supervisor_id=?');a.push(filter.supervisor_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM agent_registry'+w+' ORDER BY created_at ASC').all(...a); }

  agentMemoryInsert(row) { this._stmt('INSERT INTO agent_memory (id,agent_id,kind,scope,content_json,tags_json,source_ref,confidence,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.agent_id,row.kind,row.scope,row.content_json,row.tags_json,row.source_ref||null,row.confidence==null?null:row.confidence,row.created_at,row.expires_at||null); return this.agentMemoryGet(row.id); }
  agentMemoryGet(id) { return this._stmt('SELECT * FROM agent_memory WHERE id=?').get(id) || null; }
  agentMemoryDelete(id) { this._stmt('DELETE FROM agent_memory WHERE id=?').run(id); return { ok: true }; }
  agentMemoryList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.agent_id){c.push('agent_id=?');a.push(filter.agent_id);} if(filter.kind){c.push('kind=?');a.push(filter.kind);} if(filter.scope){c.push('scope=?');a.push(filter.scope);} if(filter.not_expired){c.push('(expires_at IS NULL OR expires_at > ?)');a.push(new Date().toISOString());} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM agent_memory'+w+' ORDER BY created_at DESC').all(...a); }
  agentMemoryDeleteByAgent(agentId, options) { options=options||{}; const c=['agent_id=?']; const a=[agentId]; if(options.kind){c.push('kind=?');a.push(options.kind);} if(options.before){c.push('created_at < ?');a.push(options.before);} const info=this._stmt('DELETE FROM agent_memory WHERE '+c.join(' AND ')).run(...a); return { deleted: info.changes || 0 }; }
  agentMemoryCountByKind(agentId) { return this._stmt('SELECT kind, COUNT(*) AS n FROM agent_memory WHERE agent_id=? GROUP BY kind').all(agentId); }

  agentTasksInsert(row) { this._stmt('INSERT INTO agent_tasks (id,title,description,state,creator_id,assignee_id,parent_task_id,handoff_count,payload_json,result_json,error,created_at,updated_at,started_at,ended_at,expires_at,job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.title,row.description||null,row.state,row.creator_id,row.assignee_id||null,row.parent_task_id||null,row.handoff_count||0,row.payload_json||null,row.result_json||null,row.error||null,row.created_at,row.updated_at,row.started_at||null,row.ended_at||null,row.expires_at||null,row.job_id||null); return this.agentTasksGet(row.id); }
  agentTasksGet(id) { return this._stmt('SELECT * FROM agent_tasks WHERE id=?').get(id) || null; }
  agentTasksUpdate(id, patch) { const cur=this.agentTasksGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE agent_tasks SET state=?, assignee_id=?, handoff_count=?, result_json=?, error=?, updated_at=?, started_at=?, ended_at=?, job_id=? WHERE id=?').run(n.state,n.assignee_id,n.handoff_count,n.result_json,n.error,n.updated_at,n.started_at,n.ended_at,n.job_id||null,id); return this.agentTasksGet(id); }
  agentTasksList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.state){c.push('state=?');a.push(filter.state);} if(filter.assignee_id){c.push('assignee_id=?');a.push(filter.assignee_id);} if(filter.creator_id){c.push('creator_id=?');a.push(filter.creator_id);} if(filter.parent_task_id){c.push('parent_task_id=?');a.push(filter.parent_task_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM agent_tasks'+w+' ORDER BY created_at DESC').all(...a); }
  agentTaskEventsInsert(row) { this._stmt('INSERT INTO agent_task_events (id,task_id,kind,actor_id,from_assignee,to_assignee,reason,payload_json,timestamp) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id,row.task_id,row.kind,row.actor_id||null,row.from_assignee||null,row.to_assignee||null,row.reason||null,row.payload_json||null,row.timestamp); return row; }
  agentTaskEventsList(taskId) { return this._stmt('SELECT * FROM agent_task_events WHERE task_id=? ORDER BY timestamp ASC').all(taskId); }

  agentToolBindingsInsert(row) { this._stmt('INSERT INTO agent_tool_bindings (id,agent_id,kind,tool_id,operations_json,enabled,created_at,created_by,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.agent_id,row.kind,row.tool_id,row.operations_json,row.enabled?1:0,row.created_at,row.created_by,row.expires_at||null,row.revoked_at||null); return this.agentToolBindingsGet(row.id); }
  agentToolBindingsGet(id) { return this._stmt('SELECT * FROM agent_tool_bindings WHERE id=?').get(id) || null; }
  agentToolBindingsUpdate(id, patch) { const cur=this.agentToolBindingsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE agent_tool_bindings SET operations_json=?, enabled=?, expires_at=?, revoked_at=? WHERE id=?').run(n.operations_json,n.enabled?1:0,n.expires_at,n.revoked_at,id); return this.agentToolBindingsGet(id); }
  agentToolBindingsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.agent_id){c.push('agent_id=?');a.push(filter.agent_id);} if(filter.kind){c.push('kind=?');a.push(filter.kind);} if(filter.tool_id){c.push('tool_id=?');a.push(filter.tool_id);} if(filter.enabled!=null){c.push('enabled=?');a.push(filter.enabled?1:0);} if(filter.active){c.push('revoked_at IS NULL');} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM agent_tool_bindings'+w+' ORDER BY created_at ASC').all(...a); }
  agentToolBindingsFind(agentId, kind, toolId) { return this._stmt('SELECT * FROM agent_tool_bindings WHERE agent_id=? AND kind=? AND tool_id=? AND revoked_at IS NULL').get(agentId,kind,toolId) || null; }

  agentEscalationsInsert(row) { this._stmt('INSERT INTO agent_escalations (id,kind,escalator_id,reviewer_id,state,summary,detail_json,tool_kind,tool_id,tool_operation,parent_escalation_id,created_at,updated_at,decided_at,expires_at,decision_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.kind,row.escalator_id,row.reviewer_id,row.state,row.summary,row.detail_json||null,row.tool_kind||null,row.tool_id||null,row.tool_operation||null,row.parent_escalation_id||null,row.created_at,row.updated_at,row.decided_at||null,row.expires_at||null,row.decision_note||null); return this.agentEscalationsGet(row.id); }
  agentEscalationsGet(id) { return this._stmt('SELECT * FROM agent_escalations WHERE id=?').get(id) || null; }
  agentEscalationsUpdate(id, patch) { const cur=this.agentEscalationsGet(id); if(!cur) return null; const n={...cur,...patch}; this._stmt('UPDATE agent_escalations SET state=?, reviewer_id=?, decided_at=?, decision_note=?, updated_at=? WHERE id=?').run(n.state,n.reviewer_id,n.decided_at,n.decision_note,n.updated_at,id); return this.agentEscalationsGet(id); }
  agentEscalationsList(filter) { filter=filter||{}; const c=[]; const a=[]; if(filter.reviewer_id){c.push('reviewer_id=?');a.push(filter.reviewer_id);} if(filter.escalator_id){c.push('escalator_id=?');a.push(filter.escalator_id);} if(filter.state){c.push('state=?');a.push(filter.state);} if(filter.kind){c.push('kind=?');a.push(filter.kind);} if(filter.parent_escalation_id){c.push('parent_escalation_id=?');a.push(filter.parent_escalation_id);} const w=c.length?' WHERE '+c.join(' AND '):''; return this._stmt('SELECT * FROM agent_escalations'+w+' ORDER BY created_at DESC').all(...a); }
  agentEscalationEventsInsert(row) { this._stmt('INSERT INTO agent_escalation_events (id,escalation_id,kind,actor_id,reason,payload_json,timestamp) VALUES (?,?,?,?,?,?,?)').run(row.id,row.escalation_id,row.kind,row.actor_id||null,row.reason||null,row.payload_json||null,row.timestamp); return row; }
  agentEscalationEventsList(escalationId) { return this._stmt('SELECT * FROM agent_escalation_events WHERE escalation_id=? ORDER BY timestamp ASC').all(escalationId); }
}

module.exports = { STORE_NAMES, openDb, Store };
