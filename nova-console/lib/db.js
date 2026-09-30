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
}

module.exports = { STORE_NAMES, openDb, Store };
