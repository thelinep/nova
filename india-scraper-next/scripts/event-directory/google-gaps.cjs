#!/usr/bin/env node
'use strict';
/* Brahmini event directory — fill India's gaps from Google Maps.
 *
 * Reads data/event-directory/gaps-IN.json (district x category combinations where the open-data
 * build found too few places) and searches Google Maps for them in the file's order (by population need once
 * geo.py has run; emptiest first otherwise), with the same
 * search code as the event-planner survey (scripts/collect-event-planners.cjs → collect()).
 *
 * Rules carried over from that collector:
 *   - one browser page, one search at a time, a pause between searches;
 *   - an access challenge, consent wall or HTTP 403/429 stops the run and it stays stopped until
 *     you have checked Google Maps yourself and create data/event-directory/REVIEWED;
 *   - create data/event-directory/PAUSE to stop after the current search;
 *   - results are public listings only, stored with the search they came from.
 *
 * Usage (from india-scraper-next): node scripts/event-directory/google-gaps.cjs [--limit 200] [--category vendor.caterer]
 * Then fold the results in: python3 scripts/event-directory/event_directory.py google && … build
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP = path.join(__dirname, '..', '..');
const OUT = process.env.EVENT_DIRECTORY_DIR || path.join(APP, 'data', 'event-directory');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const COUNTRY = String(arg('country', 'IN')).toUpperCase();
const LIMIT = Math.max(1, Number(arg('limit', 200)) || 200);
const ONLY = arg('category', null);
const PAUSE_MS = [Number(process.env.GAPS_PAUSE_MIN_MS || 4000), Number(process.env.GAPS_PAUSE_MAX_MS || 9000)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
let halted = false;

function openDb() {
  fs.mkdirSync(OUT, { recursive: true });
  const db = new DatabaseSync(path.join(OUT, `google-${COUNTRY}.db`));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, district TEXT NOT NULL, state TEXT NOT NULL, state_code TEXT, category_id TEXT NOT NULL, query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, results INTEGER, note TEXT, started_at TEXT, finished_at TEXT, source_url TEXT, priority INTEGER);
    CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, phone TEXT, website TEXT, address TEXT, rating TEXT, reviews TEXT,
      latitude REAL, longitude REAL, maps_url TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, raw_json TEXT);
    CREATE TABLE IF NOT EXISTS discoveries (task_id TEXT NOT NULL, business_id TEXT NOT NULL, captured_at TEXT NOT NULL, raw_json TEXT, PRIMARY KEY (task_id, business_id));
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, priority);`);
  return db;
}
const setMeta = (db, k, v) => db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));

/** Stable id for a Google Maps place, the same rule as the event-planner survey. */
function placeKey(url) {
  try { const store = require('../../lib/event-planners/store.cjs'); if (store.placeKey) return store.placeKey(url); } catch (_) {}
  const m = String(url).match(/!1s([^!]+)/) || String(url).match(/[?&]cid=(\d+)/);
  return m ? m[1] : require('node:crypto').createHash('sha1').update(String(url).split('?')[0]).digest('hex');
}

function loadGaps(db) {
  const file = path.join(OUT, `gaps-${COUNTRY}.json`);
  if (!fs.existsSync(file)) throw new Error(`No ${path.basename(file)} yet. Run "Build event directory" first.`);
  const { gaps } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO tasks (id, district, state, state_code, category_id, query, priority) VALUES (?,?,?,?,?,?,?)');
  const reprioritise = db.prepare("UPDATE tasks SET priority=? WHERE id=? AND status='pending'");
  let added = 0;
  gaps.forEach((g, i) => {
    if (ONLY && g.category !== ONLY) return;
    const id = `${g.key}|${g.category}`;
    added += insert.run(id, g.district, g.state, g.stateCode || null, g.category, g.query, i).changes;
    reprioritise.run(i, id);
  });
  return { total: gaps.length, added };
}

function persist(db, task, result) {
  const now = stamp();
  const upsert = db.prepare(`INSERT INTO businesses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category,
    phone=COALESCE(excluded.phone, businesses.phone), website=COALESCE(excluded.website, businesses.website), address=COALESCE(excluded.address, businesses.address),
    rating=excluded.rating, reviews=excluded.reviews, latitude=excluded.latitude, longitude=excluded.longitude, maps_url=excluded.maps_url, last_seen=excluded.last_seen, raw_json=excluded.raw_json`);
  const found = db.prepare('INSERT OR IGNORE INTO discoveries VALUES (?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of result.records) {
      const id = placeKey(r.maps_url);
      upsert.run(id, r.name, r.category ?? null, r.phone ?? null, r.website ?? null, r.address ?? null, r.rating ?? null, r.reviews ?? null, r.latitude ?? null, r.longitude ?? null, r.maps_url, now, now, JSON.stringify(r));
      found.run(task.id, id, now, JSON.stringify(r));
    }
    db.prepare('UPDATE tasks SET status=?, finished_at=?, results=?, note=?, source_url=? WHERE id=?').run(result.status, now, result.records.length, result.note ?? null, result.url ?? null, task.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function main() {
  const lock = path.join(OUT, `google-${COUNTRY}.lock`);
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    const pid = Number(fs.readFileSync(lock, 'utf8')); let alive = true; try { process.kill(pid, 0); } catch (_) { alive = false; }
    if (alive) throw new Error(`Another gap run (pid ${pid}) is active.`);
    fs.writeFileSync(lock, String(process.pid));
  }
  const db = openDb();
  try {
    const reviewed = path.join(OUT, 'REVIEWED');
    if (fs.existsSync(reviewed)) { db.exec("UPDATE tasks SET status='pending', note='Retried after operator review' WHERE status='blocked'"); fs.unlinkSync(reviewed); console.log('Operator review noted; blocked searches will be retried.'); }
    const blocked = db.prepare("SELECT count(*) AS n FROM tasks WHERE status='blocked'").get().n;
    if (blocked) {
      console.log('\nGoogle showed an access challenge or consent page last time, so this stays stopped.\nOpen Google Maps in Chrome and check it works normally. Then create an empty file named REVIEWED in\n  ' + OUT + '\nand run this again. Nothing tries to get around the challenge.');
      process.exitCode = 3; return;
    }
    db.exec("UPDATE tasks SET status='pending', note='Resuming interrupted search' WHERE status='running'");
    const { total, added } = loadGaps(db);
    const pending = db.prepare("SELECT * FROM tasks WHERE status='pending' ORDER BY priority LIMIT ?").all(LIMIT);
    const left = db.prepare("SELECT count(*) AS n FROM tasks WHERE status='pending'").get().n;
    console.log(`${total} gaps in the latest build (${added} new). ${left} searches waiting; this run does up to ${pending.length}.`);
    if (!pending.length) return;

    const { collect } = require('../collect-event-planners.cjs');
    const puppeteer = require('puppeteer');
    setMeta(db, 'runnerState', 'running'); setMeta(db, 'lastStartedAt', stamp());
    const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
      const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
      let done = 0, listings = 0;
      for (const task of pending) {
        if (halted) break;
        if (fs.existsSync(path.join(OUT, 'PAUSE'))) { setMeta(db, 'pauseReason', 'Operator PAUSE file'); console.log('PAUSE file found; stopping.'); break; }
        db.prepare("UPDATE tasks SET status='running', attempts=attempts+1, started_at=? WHERE id=?").run(stamp(), task.id);
        let result;
        try { result = await collect(page, task); }
        catch (e) { db.prepare("UPDATE tasks SET status='failed', finished_at=?, note=? WHERE id=?").run(stamp(), e.message, task.id); console.error(`${task.district} · ${task.category_id}: ${e.message}`); continue; }
        persist(db, task, result); done++; listings += result.records.length;
        console.log(`${stamp()} [${done}/${pending.length}] ${task.state} / ${task.district} · ${task.category_id}: ${result.records.length} (${result.status})`);
        if (result.status === 'blocked') {
          setMeta(db, 'pauseReason', result.note); await page.screenshot({ path: path.join(OUT, 'blocked.png') }).catch(() => {});
          console.log('\nGoogle showed an access challenge. Stopped without trying to get around it (screenshot: blocked.png).'); process.exitCode = 3; break;
        }
        await sleep(PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]));
      }
      console.log(`\nThis run: ${done} searches, ${listings} listings.`);
    } finally { await browser.close().catch(() => {}); }
    setMeta(db, 'runnerState', halted ? 'paused' : 'idle'); setMeta(db, 'finishedAt', stamp());
  } finally { db.close(); try { fs.unlinkSync(lock); } catch (_) {} }
}

process.on('SIGINT', () => { halted = true; }); process.on('SIGTERM', () => { halted = true; });
if (require.main === module) main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { openDb, loadGaps, persist, placeKey };
