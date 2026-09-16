const { createEvidence, validateEvidence } = require('../lib/event-planners/query-evidence.cjs');
const { collect } = require('../scripts/collect-event-planners.cjs');
const { hasCompletedCheckpoint } = require('../scripts/run-delhi-venue-queries.cjs');
const sqlite3 = require('sqlite3');
const store = require('../lib/event-planners/store.cjs');

const record = { name:'Venue A', maps_url:'https://www.google.com/maps/place/venue-a', source:'Google Maps public search', verification_status:'SOURCE_LISTED_UNVERIFIED', district_membership:'UNVERIFIED_SEARCH_ASSOCIATION' };
const input = { id:'query-1', task:{id:'DL:1',district:'New Delhi'}, method:{id:'venue-banquet-halls',name:'Delhi venues'}, query:'banquet halls in New Delhi district, Delhi, India', startedAt:'2026-09-15T00:00:00.000Z', finishedAt:'2026-09-15T00:00:01.000Z', result:{status:'limited_view',note:'source limited',records:[record],url:'https://www.google.com/maps/search/banquet%20halls?hl=en'} };

test('real runner evidence contains the complete versioned query contract',()=>{const value=createEvidence(input);expect(value).toMatchObject({schemaVersion:1,queryHistoryId:'query-1',taskId:'DL:1',methodId:'venue-banquet-halls',category:'banquet halls',resultCount:1,status:'limited_view'});expect(value.rawRecords).toEqual([record]);});
test('query evidence rejects count drift and missing provenance',()=>{const value=createEvidence(input);expect(()=>validateEvidence({...value,resultCount:2})).toThrow(/count/);expect(()=>validateEvidence({...value,rawRecords:[{...record,verification_status:'VERIFIED'}]})).toThrow(/verification/);});
test('real runner checkpoint query skips only completed source-observation states',async()=>{const db=new sqlite3.Database(':memory:');try{await store.run(db,'CREATE TABLE query_history (id TEXT,task_id TEXT,method_id TEXT,status TEXT)');await store.run(db,"INSERT INTO query_history VALUES ('q1','task-1','venue-banquet-halls','limited_view')");await store.run(db,"INSERT INTO query_history VALUES ('q2','task-2','venue-banquet-halls','failed')");expect(await hasCompletedCheckpoint(db,'venue-banquet-halls','task-1')).toBe(true);expect(await hasCompletedCheckpoint(db,'venue-banquet-halls','task-2')).toBe(false);}finally{await store.close(db);}});
test('collector challenge drill stops on HTTP throttling without extracting records',async()=>{const page={goto:jest.fn().mockResolvedValue({status:()=>429})};await expect(collect(page,{query:'banquet halls in Delhi'})).resolves.toMatchObject({status:'blocked',records:[],note:'HTTP 429'});});
