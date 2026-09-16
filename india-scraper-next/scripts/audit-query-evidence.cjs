#!/usr/bin/env node
const store = require('../lib/event-planners/store.cjs');
const { validateEvidence } = require('../lib/event-planners/query-evidence.cjs');

(async () => {
  const db = await store.open(false);
  try {
    const rows = await store.all(db, `SELECT q.*,t.district,t.state FROM query_history q JOIN tasks t ON t.id=q.task_id WHERE q.records_json IS NOT NULL ORDER BY q.started_at`);
    const failures = [];
    for (const row of rows) {
      try {
        const records = JSON.parse(row.records_json);
        validateEvidence({ schemaVersion: 1, queryHistoryId: row.id, taskId: row.task_id, methodId: row.method_id, query: row.query, district: row.district, category: row.method_id, sourceUrl: `https://www.google.com/maps/search/${encodeURIComponent(row.query)}?hl=en`, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, resultCount: row.results, limitation: row.note, rawRecords: records });
      } catch (error) { failures.push({ queryHistoryId: row.id, error: error.message }); }
    }
    const total = (await store.all(db, 'SELECT count(*) AS n FROM query_history'))[0].n;
    console.log(JSON.stringify({ schemaVersion: 1, auditedAt: new Date().toISOString(), queryHistoryRows: total, rawEvidenceRows: rows.length, validRawEvidenceRows: rows.length - failures.length, failures, limitation: `${total - rows.length} legacy query row(s) do not retain records_json and cannot be reconstructed as raw evidence.` }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally { await store.close(db); }
})().catch(error => { console.error(error); process.exitCode = 1; });
