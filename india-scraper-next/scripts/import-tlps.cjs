#!/usr/bin/env node
// Builds only the derived location catalogue. The collector data.db is never opened.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const sqlite3 = require('sqlite3');
const {all, close} = require('../lib/locations/catalog.cjs');
const root = path.join(__dirname, '../data/tlps');
const manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestHash = sha(manifestBytes);
const filename = path.join(root, 'catalog.db');
const temporary = path.join(root, `catalog.build-${process.pid}.db`);
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
const read = name => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'campaign', `${name}.gz`))));
async function main() {
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, file.path));
    if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes) throw Error(`Snapshot checksum mismatch: ${file.path}`);
    if (file.sourceSha256 && sha(zlib.gunzipSync(bytes)) !== file.sourceSha256) throw Error(`Uncompressed source mismatch: ${file.path}`);
  }
  console.log(`Verified ${manifest.files.length} source files`);
  if (fs.existsSync(filename)) {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY);
    try {
      const rows = await all(db, 'SELECT value FROM metadata WHERE key = ?', ['summary']);
      if (JSON.parse(rows[0].value).manifestSha256 === manifestHash && JSON.parse(rows[0].value).storageVersion === 2) { console.log('Catalogue already matches source manifest.'); return; }
    } finally { await close(db); }
  }
  const db = new sqlite3.Database(temporary);
  try {
    await run(db, 'PRAGMA journal_mode=DELETE');
    await run(db, 'CREATE TABLE locations (id TEXT PRIMARY KEY, corpus TEXT NOT NULL, dataset TEXT NOT NULL, name TEXT, category TEXT, state TEXT, city TEXT, district TEXT, latitude REAL, longitude REAL, status TEXT, block_id INTEGER NOT NULL, block_offset INTEGER NOT NULL)');
    await run(db, 'CREATE TABLE record_blocks (id INTEGER PRIMARY KEY, raw BLOB NOT NULL)');
    await run(db, 'CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await run(db, 'BEGIN');
    const statement = db.prepare('INSERT INTO locations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let pending = [], total = 0, block = [], blockId = 1;
    async function flushBlock() {
      if (!block.length) return;
      await Promise.all(pending); pending = [];
      await run(db, 'INSERT INTO record_blocks VALUES (?,?)', [blockId, zlib.deflateRawSync(Buffer.from(JSON.stringify(block)))]);
      block = []; blockId++;
    }
    const finite = (v, max) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max ? Number(v) : null;
    async function add(record, corpus, dataset) {
      if (!record.id) throw Error('Source record is missing an ID');
      const values = [`${corpus}:${dataset}:${record.id}`, corpus, dataset, String(record.name || ''), String(record.category || ''), String(record.state || ''), String(record.city || ''), String(record.district || ''), finite(record.latitude,90), finite(record.longitude,180), String(record.status || ''), blockId, block.length];
      block.push(record);
      pending.push(new Promise((resolve, reject) => statement.run(values, error => error ? reject(error) : resolve())));
      total++;
      if (block.length >= 500) await flushBlock();
    }
    const html = zlib.gunzipSync(fs.readFileSync(path.join(root,'campaign/index.html.gz'))).toString('utf8');
    const embedded = JSON.parse(html.match(/<script id="seed" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    for (const record of embedded.records) await add(record,'campaign','embedded');
    for (const [dataset, file] of [['iocl','iocl-outlets.json'],['jiobp','jiobp-outlets.json'],['media_ant','media-ant-inventory.json'],['transport_osm','transport-inventory.json'],['world_reference','world-capitals-currencies.json'],['world_film','world-film-locations.json'],['district_context','district-context.json']]) {
      for (const record of read(file).records) await add(record,'campaign',dataset);
    }
    if (total !== manifest.campaignRecords) throw Error(`Campaign count mismatch: ${total}`);
    const globalManifest = JSON.parse(fs.readFileSync(path.join(root, 'global/manifest.json')));
    for (const [group, file] of Object.entries(globalManifest.files)) {
      const stream = fs.createReadStream(path.join(root,'global',file.file)).pipe(zlib.createGunzip());
      const lines = readline.createInterface({input:stream,crlfDelay:Infinity});
      let count = 0;
      for await (const line of lines) if (line) { await add(JSON.parse(line),'global',group); count++; }
      if (count !== file.records) throw Error(`Global group mismatch: ${group}`);
      console.log(`${group}: ${count}`);
    }
    await flushBlock();
    await new Promise((resolve,reject)=>statement.finalize(error=>error?reject(error):resolve()));
    if (total !== manifest.totalRecords) throw Error(`Total mismatch: ${total}`);
    await run(db,'CREATE INDEX location_corpus_category ON locations(corpus,category)');
    await run(db,'CREATE INDEX location_state ON locations(state)');
    await run(db,'CREATE INDEX location_coordinates ON locations(latitude,longitude)');
    await run(db,"CREATE VIRTUAL TABLE locations_fts USING fts5(name, category, state, city, district, content='locations', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')");
    await run(db,"INSERT INTO locations_fts(locations_fts) VALUES ('rebuild')");
    const [{executionReady}] = await all(db,"SELECT count(*) AS executionReady FROM locations WHERE status='EXECUTION_READY'");
    if (executionReady !== 0) throw Error('Unexpected execution-ready claim');
    const summary = { storageVersion:2, total, campaign:manifest.campaignRecords, global:manifest.globalRecords, executionReady, manifestSha256:manifestHash,
      categories:await all(db,'SELECT corpus,category,count(*) AS count FROM locations GROUP BY corpus,category ORDER BY category'),
      states:await all(db,'SELECT corpus,state,count(*) AS count FROM locations WHERE state <> ? GROUP BY corpus,state ORDER BY state',['']) };
    await run(db,'INSERT INTO metadata VALUES (?,?)',['summary',JSON.stringify(summary)]);
    await run(db,'COMMIT');
    await close(db);
    await fsp.rename(temporary,filename);
    console.log(`Imported ${total} records. Zero execution-ready sites. ${Math.round(fs.statSync(filename).size/1024/1024)} MiB index.`);
  } catch (error) {
    await run(db,'ROLLBACK').catch(()=>{});
    await close(db).catch(()=>{});
    await fsp.rm(temporary,{force:true});
    await fsp.rm(`${temporary}-journal`,{force:true});
    throw error;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
