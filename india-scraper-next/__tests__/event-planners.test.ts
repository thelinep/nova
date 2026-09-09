/** @jest-environment node */
import sqlite3 from 'sqlite3';
it('separates explicit planner categories from unrelated search candidates',()=>{
  const {isPlanner}=require('../lib/event-planners/store.cjs');
  for(const category of ['Event planner','Wedding planner','Party planner',' Event management company '])expect(isPlanner(category)).toBe(true);
  for(const category of [null,'Restaurant','Relaxed rooftop eatery for seafood','Wedding venue'])expect(isPlanner(category)).toBe(false);
});
const {initialize,all,run,close,placeKey,queryParams}=require('../lib/event-planners/store.cjs');
it('deduplicates the same Google place across district searches without merging different places',()=>{
  expect(placeKey('https://www.google.com/maps/place/A/data=!1s0x123:0x456!3d1!4d2?hl=en')).toBe(placeKey('https://www.google.com/maps/place/A/data=!1s0x123:0x456!3d1!4d2?hl=hi'));
  expect(placeKey('https://www.google.com/maps?cid=123')).not.toBe(placeKey('https://www.google.com/maps?cid=124'));
});
it.each(['abc','Infinity','-1','201','1.5'])('rejects unbounded pagination %s',limit=>{
  expect(()=>queryParams(new URLSearchParams({limit}))).toThrow('INVALID_PAGINATION');
});
it('retains per-district observations and distinguishes partial and blocked work',async()=>{
  const db=new sqlite3.Database(':memory:');
  try {
    await initialize(db);
    await run(db,'INSERT INTO tasks (id,district,state,state_code,directory_url,query,status) VALUES (?,?,?,?,?,?,?)',['district-1','Test district','Test state','TS','https://igod.gov.in/','event planners','limited_view']);
    await run(db,'INSERT INTO businesses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',['google:test','Fixture Planner','Event planner',null,null,null,null,null,1,2,'https://www.google.com/maps?cid=test','2026-09-09','2026-09-09','{"fixture":true}']);
    await run(db,'INSERT INTO discoveries VALUES (?,?,?,?)',['district-1','google:test','2026-09-09','{"fixture":true,"contact_person":null}']);
    expect((await all(db,'SELECT status FROM tasks'))[0].status).toBe('limited_view');
    expect(JSON.parse((await all(db,'SELECT raw_json FROM discoveries'))[0].raw_json).contact_person).toBeNull();
    expect((await all(db,'SELECT count(*) AS count FROM discoveries'))[0].count).toBe(1);
  } finally {await close(db);}
});
