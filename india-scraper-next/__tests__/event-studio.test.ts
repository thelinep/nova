/** @jest-environment node */
import sqlite3 from 'sqlite3';
const s=require('../lib/event-planners/store.cjs');
const studio=require('../lib/event-planners/studio.cjs');
it('validates and renders district method templates',()=>{
 expect(studio.render('planners {district}, {state}',{district:'Delhi',state:'Delhi'})).toBe('planners Delhi, Delhi');
 expect(()=>studio.render('missing scope',{})).toThrow();
});
it('preserves historical failure when a district is retried successfully',async()=>{
 const db=new sqlite3.Database(':memory:');try{await s.initialize(db);
 await s.run(db,"INSERT INTO tasks(id,district,state,state_code,directory_url,query,status,attempts) VALUES ('d','District','State','S','url','query','failed',1)");
 await studio.init(db);await s.run(db,"UPDATE tasks SET status='limited_view',attempts=2");await studio.init(db);await studio.init(db);
 const rows=await s.all(db,'SELECT status FROM query_history ORDER BY id');expect(rows.map((r:{status:string})=>r.status)).toEqual(['failed','limited_view']);
 }finally{await s.close(db);}
});
