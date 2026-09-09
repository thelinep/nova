const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const sqlite3 = require('sqlite3');

const defaultPath = () => path.join(process.cwd(), 'data', 'tlps', 'catalog.db');
function openDatabase(filename = defaultPath()) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
  });
}
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
class InputError extends Error {}
function integer(value, fallback, min, max, label) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new InputError(`${label} must be an integer from ${min} to ${max}`);
  return Number(value);
}
function parseQuery(params) {
  const q = (params.get('q') || '').trim();
  if (q.length > 160) throw new InputError('Search must be at most 160 characters');
  const corpus = params.get('corpus') || '';
  if (!['', 'campaign', 'global'].includes(corpus)) throw new InputError('Unknown corpus');
  const result = { q, corpus, category: params.get('category') || '', state: params.get('state') || '', id: params.get('id') || '', limit: integer(params.get('limit'), 100, 1, 500, 'limit'), offset: integer(params.get('offset'), 0, 0, 1000000, 'offset'), bbox: null };
  if ([result.category, result.state, result.id].some(value => value.length > 200)) throw new InputError('Filter is too long');
  if (params.has('bbox')) {
    const parts = params.get('bbox').split(',');
    const values = parts.map(Number);
    if (parts.length !== 4 || parts.some(p => !p.trim()) || values.some(n => !Number.isFinite(n)) || Math.abs(values[0]) > 180 || Math.abs(values[2]) > 180 || Math.abs(values[1]) > 90 || Math.abs(values[3]) > 90 || values[1] > values[3]) throw new InputError('bbox must be west,south,east,north in valid degrees');
    result.bbox = values;
  }
  return result;
}
function whereClause(input) {
  const clauses = [], values = [];
  if (input.q) {
    const terms = input.q.match(/[\p{L}\p{N}]+/gu) || [];
    if (!terms.length) clauses.push('0');
    else { clauses.push('rowid IN (SELECT rowid FROM locations_fts WHERE locations_fts MATCH ?)'); values.push(terms.map(t => `"${t}"*`).join(' AND ')); }
  }
  for (const key of ['corpus', 'category', 'state', 'id']) if (input[key]) { clauses.push(`${key} = ?`); values.push(input[key]); }
  if (input.bbox) {
    const [w,s,e,n] = input.bbox;
    clauses.push('latitude BETWEEN ? AND ?'); values.push(s,n);
    clauses.push(w <= e ? 'longitude BETWEEN ? AND ?' : '(longitude >= ? OR longitude <= ?)'); values.push(w,e);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}
async function search(params, filename) {
  const input = parseQuery(params);
  const db = await openDatabase(filename);
  try {
    const {sql, values} = whereClause(input);
    const [{total}] = await all(db, `SELECT COUNT(*) AS total FROM locations${sql}`, values);
    const rows = await all(db, `SELECT id, corpus, dataset, name, category, state, city, district, latitude, longitude, block_id, block_offset FROM locations${sql} ORDER BY rowid LIMIT ? OFFSET ?`, [...values, input.limit, input.offset]);
    const records = new Array(rows.length);
    const byBlock = new Map();
    rows.forEach((row,index) => { if (!byBlock.has(row.block_id)) byBlock.set(row.block_id, []); byBlock.get(row.block_id).push({row,index}); });
    for (const [blockId, entries] of byBlock) {
      const [{raw}] = await all(db, 'SELECT raw FROM record_blocks WHERE id = ?', [blockId]);
      const originals = JSON.parse(zlib.inflateRawSync(raw).toString('utf8'));
      for (const {row,index} of entries) { const {block_id,block_offset,...record} = row; records[index] = {...record,sourceRecord:originals[block_offset]}; }
    }
    return { total, limit: input.limit, offset: input.offset, hasMore: input.offset + records.length < total, records };
  } finally { await close(db); }
}
async function summary(filename) {
  const db = await openDatabase(filename);
  try {
    const [{value}] = await all(db, 'SELECT value FROM metadata WHERE key = ?', ['summary']);
    return JSON.parse(value);
  } finally { await close(db); }
}
function manifest() { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/tlps/manifest.json'), 'utf8')); }
module.exports = { parseQuery, whereClause, search, summary, openDatabase, all, close, InputError, manifest };
