const s=require('./store.cjs');
const crypto=require('node:crypto');
const DEFAULT='event planners in {district} district, {state}, India';
async function init(db){
 await s.run(db,'CREATE TABLE IF NOT EXISTS query_methods (id TEXT PRIMARY KEY,name TEXT,template TEXT,created_at TEXT,engine TEXT)');
 await s.run(db,'CREATE TABLE IF NOT EXISTS query_history (id TEXT PRIMARY KEY,task_id TEXT,method_id TEXT,query TEXT,status TEXT,started_at TEXT,finished_at TEXT,results INTEGER,note TEXT,records_json TEXT)');
 await s.run(db,'INSERT OR IGNORE INTO query_methods VALUES (?,?,?,?,?)',['original','Original district search',DEFAULT,new Date().toISOString(),'Puppeteer; Google Maps public search; collector v1']);
 await s.run(db,`INSERT OR IGNORE INTO query_history SELECT 'legacy:'||id||':'||attempts,id,'original',query,status,started_at,finished_at,results,note,NULL FROM tasks WHERE attempts>0 AND status NOT IN ('pending','running')`);
}
function render(template,district){if(typeof template!=='string'||template.length>300||!template.includes('{district}')||!template.includes('{state}'))throw Error('Template must contain {district} and {state}, maximum 300 characters');return template.replaceAll('{district}',district.district).replaceAll('{state}',district.state);}
async function get(){const db=await s.open(false);try{await init(db);return {methods:await s.all(db,'SELECT * FROM query_methods ORDER BY created_at DESC'),tasks:await s.all(db,`SELECT *,CASE WHEN status IN ('limited_view','visible_list_exhausted','no_results') THEN 'Succeeded (source-limited)' WHEN status='partial' THEN 'Partial' WHEN status='failed' THEN 'Failed' ELSE status END AS outcome FROM tasks ORDER BY state,district`),history:await s.all(db,'SELECT * FROM query_history ORDER BY started_at DESC LIMIT 100')};}finally{await s.close(db);}}
async function save(body){const db=await s.open(false);try{await init(db);if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100)throw Error('Provide a method name up to 100 characters');render(body.template,{district:'District',state:'State'});const id=crypto.randomUUID();await s.run(db,'INSERT INTO query_methods VALUES (?,?,?,?,?)',[id,body.name.trim(),body.template,new Date().toISOString(),'Puppeteer; Google Maps public search; collector v1']);return {id};}finally{await s.close(db);}}
module.exports={init,render,get,save};
