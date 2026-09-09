const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const {summary, search, openDatabase, all, close} = require('../lib/locations/catalog.cjs');
(async()=>{
  const bytes=fs.readFileSync(path.join(process.cwd(),'data/tlps/manifest.json'));
  const manifest=JSON.parse(bytes);
  for(const file of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(),'data/tlps',file.path))).digest('hex'),file.sha256,file.path);
  const s=await summary();
  assert.equal(s.total,763953); assert.equal(s.campaign,55731); assert.equal(s.global,708222); assert.equal(s.executionReady,0);
  assert.equal(s.manifestSha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  // FTS5 quick_check needs a writable connection even though no application rows are changed.
  const db=await new Promise((resolve,reject)=>{const connection=new sqlite3.Database(path.join(process.cwd(),'data/tlps/catalog.db'),sqlite3.OPEN_READWRITE,error=>error?reject(error):resolve(connection));});
  try {
    assert.deepEqual(await all(db,'PRAGMA quick_check'),[{'quick_check':'ok'}]);
    assert.equal((await all(db,'SELECT COUNT(*) AS n FROM locations'))[0].n,s.total);
    assert.equal((await all(db,"SELECT COUNT(*) AS n FROM locations WHERE status='EXECUTION_READY'"))[0].n,0);
  } finally {await close(db);}
  const first=await search(new URLSearchParams('corpus=global&q=Paris&limit=5'));
  assert(first.total>0); assert(first.records.length<=5);
  assert.equal(first.records[0].sourceRecord.verification_status,'GEONAMES_COORDINATE_UNVERIFIED');
  await assert.rejects(()=>search(new URLSearchParams('limit=abc')),/integer/);
  console.log(JSON.stringify({sourceFilesVerified:manifest.files.length,total:s.total,campaign:s.campaign,global:s.global,executionReady:s.executionReady,sqlite:'ok',boundedSearch:'passed',invalidLimit:'rejected'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
