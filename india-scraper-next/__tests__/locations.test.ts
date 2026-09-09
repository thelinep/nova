/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sqlite3 from 'sqlite3';
import {Script,runInNewContext} from 'node:vm';
import {parseQuery,search} from '../lib/locations/catalog.cjs';
import {adaptExplorer,campaignFile} from '../lib/locations/snapshots';
let directory:string, filename:string;
beforeAll(async()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'brahmini-location-test-'));filename=path.join(directory,'fixture.db');
  const db=new sqlite3.Database(filename);
  const run=(sql:string,params:unknown[]=[])=>new Promise<void>((resolve,reject)=>db.run(sql,params,e=>e?reject(e):resolve()));
  await run('CREATE TABLE locations (id TEXT, corpus TEXT, dataset TEXT, name TEXT, category TEXT, state TEXT, city TEXT, district TEXT, latitude REAL, longitude REAL, block_id INTEGER, block_offset INTEGER)');
  await run('CREATE TABLE record_blocks (id INTEGER PRIMARY KEY, raw BLOB)');
  let blockId=0;
  // Deliberate fixtures isolate pagination, source namespace and antimeridian behavior.
  for(const [id,corpus,longitude] of [['campaign:same','campaign',179],['global:same','global',-179],['global:other','global',10]] as const) {
    const raw={id:'same',name:'Test Harbour',status:'SOURCE_LISTED_DISCOVERY',permission_status:'REQUIRED',latitude:10,longitude};
    await run('INSERT INTO locations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[id,corpus,'fixture',raw.name,'Harbour','Test country','Test city','',10,longitude,++blockId,0]);
    await run('INSERT INTO record_blocks VALUES (?,?)',[blockId,zlib.deflateRawSync(Buffer.from(JSON.stringify([raw])))]);
  }
  await run("CREATE VIRTUAL TABLE locations_fts USING fts5(name,category,state,city,district,content='locations',content_rowid='rowid')");
  await run("INSERT INTO locations_fts(locations_fts) VALUES ('rebuild')");
  await new Promise<void>((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
});
afterAll(()=>fs.rmSync(directory,{recursive:true,force:true}));
it.each(['abc','NaN','Infinity','1.2','0','-1','501',''])('rejects invalid limit %s',limit=>{expect(()=>parseQuery(new URLSearchParams({limit}))).toThrow(/integer/);});
it('rejects invalid offsets, corpora and map bounds',()=>{
  for(const query of ['offset=-1','offset=1.5','corpus=unknown','bbox=0,20,10,10','bbox=0,0,181,20','bbox=0,,20,20','bbox=0,0,NaN,20']) expect(()=>parseQuery(new URLSearchParams(query))).toThrow();
});
it('preserves source identity and truth gates across corpus filtering and pagination',async()=>{
  const first=await search(new URLSearchParams('q=Harb&limit=1'),filename);
  expect(first.total).toBe(3);expect(first.hasMore).toBe(true);expect(first.records).toHaveLength(1);
  const second=await search(new URLSearchParams('q=Harb&limit=1&offset=1'),filename);
  expect(first.records[0].id).not.toBe(second.records[0].id);
  expect(second.records[0].sourceRecord.permission_status).toBe('REQUIRED');
  const campaign=await search(new URLSearchParams('corpus=campaign'),filename);expect(campaign.total).toBe(1);
});
it('supports antimeridian map searches without including unrelated longitudes',async()=>{
  const result=await search(new URLSearchParams('bbox=170,0,-170,20'),filename);expect(result.total).toBe(2);
  const empty=await search(new URLSearchParams('bbox=50,0,60,20'),filename);expect(empty.total).toBe(0);
});
it('treats SQL and FTS syntax as search text',async()=>{
  const result=await search(new URLSearchParams({q:'" OR 1=1 --'}),filename);expect(result.total).toBe(0);
  expect((await search(new URLSearchParams('q=Harbour'),filename)).total).toBe(3);
});
it('serves only allowlisted snapshots and namespaces the absorbed explorer',async()=>{
  await expect(campaignFile('../../data.db')).rejects.toThrow('Unknown snapshot');
  const html=adaptExplorer(await campaignFile('index.html'));
  expect(html).toContain('/vendor/leaflet/leaflet.js');
  expect(html).not.toContain('/api/locations?recordType=');
  expect(html.match(/loadExternal\('\/api\/tlps\/snapshots\//g)).toHaveLength(8);
  expect(html).toContain('brahmini-tlps-campaign-v1');
  for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(()=>new Script(script[1])).not.toThrow();
  const prelude=html.match(/const SEED=[\s\S]*?hiddenPinCategories=new Set\(\);/)![0];
  const seed={records:[{id:'LOC-1',name:'Original source'}]};
  const preserved=runInNewContext(prelude+`;planningRecords([{id:'LOC-1',name:'Original source'},{id:'LOC-2',name:'Manual pin'}])`,{document:{getElementById:()=>({textContent:JSON.stringify(seed)})},localStorage:{getItem:()=>null},setTimeout:()=>{}});
  expect(preserved.map((record:{id:string})=>record.id)).toEqual(['LOC-2']);
});
