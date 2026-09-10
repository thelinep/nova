const sqlite3 = require('sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this.changes)}));
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
const text=(v,max,label)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(`${label} must contain 1–${max} characters`);return v.trim()};
function createStore(filename=process.env.MAATAA_DB_PATH||path.join(process.cwd(),'data/maataa/conversations.db')) {
 async function use(fn){fs.mkdirSync(path.dirname(filename),{recursive:true});const db=await new Promise((resolve,reject)=>{const d=new sqlite3.Database(filename,e=>e?reject(e):resolve(d))});try{
 await run(db,'PRAGMA busy_timeout=5000');await run(db,'PRAGMA journal_mode=WAL');
 await run(db,`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
 await run(db,`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,prompt TEXT NOT NULL,response TEXT,model TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT)`);
 await run(db,`CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,published_at TEXT)`);
 return await fn(db);
 }finally{await new Promise((r,j)=>db.close(e=>e?j(e):r()))}}
 const exists=async(db,id)=>{if(!(await all(db,'SELECT id FROM conversations WHERE id=?',[id])).length)throw Error('Conversation not found')};
 return {
 snapshot:()=>use(async db=>({conversations:await all(db,'SELECT * FROM conversations ORDER BY updated_at DESC'),publications:await all(db,'SELECT * FROM publications ORDER BY created_at DESC')})),
 detail:id=>use(async db=>{await exists(db,id);return {messages:await all(db,'SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid',[id])}}),
 create:body=>use(async db=>{const id=randomUUID(),now=new Date().toISOString();await run(db,'INSERT INTO conversations VALUES(?,?,?,?,?)',[id,text(body.title,120,'Title'),text(body.category,60,'Category'),now,now]);return {id}}),
 categorize:body=>use(async db=>{await exists(db,body.id);await run(db,'UPDATE conversations SET category=?,updated_at=? WHERE id=?',[text(body.category,60,'Category'),new Date().toISOString(),body.id]);return {ok:true}}),
 begin:body=>use(async db=>{await run(db,'BEGIN IMMEDIATE');try{await exists(db,body.id);await run(db,"UPDATE messages SET status='failed',error='Interrupted or timed out; resend to retry',finished_at=? WHERE conversation_id=? AND status='pending' AND created_at<?",[new Date().toISOString(),body.id,new Date(Date.now()-240000).toISOString()]);if((await all(db,"SELECT id FROM messages WHERE conversation_id=? AND status='pending'",[body.id])).length)throw Error('A reply is already running in this conversation');const id=randomUUID(),now=new Date().toISOString();await run(db,'INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)',[id,body.id,text(body.prompt,8000,'Prompt'),null,text(body.model,150,'Model'),body.mode,'pending',null,now,null]);await run(db,'UPDATE conversations SET updated_at=? WHERE id=?',[now,body.id]);await run(db,'COMMIT');return {id}}catch(e){await run(db,'ROLLBACK');throw e}}),
 finish:(id,response,error)=>use(db=>run(db,'UPDATE messages SET response=?,status=?,error=?,finished_at=? WHERE id=?',[response,error?'failed':'complete',error||null,new Date().toISOString(),id])),
 draft:body=>use(async db=>{await exists(db,body.id);if(!['update','milestone'].includes(body.kind))throw Error('Choose update or milestone');const id=randomUUID();const [conversation]=await all(db,'SELECT category FROM conversations WHERE id=?',[body.id]);await run(db,'INSERT INTO publications VALUES(?,?,?,?,?,?,?,?,?)',[id,body.id,text(body.title,120,'Title'),text(body.body,8000,'Publication'),body.kind,conversation.category,'draft',new Date().toISOString(),null]);return {id}}),
 publish:body=>use(async db=>{const count=await run(db,"UPDATE publications SET status='published',published_at=? WHERE id=? AND status='draft'",[new Date().toISOString(),body.id]);if(!count)throw Error('Draft not found or already published');return {ok:true}}),
 };
}
module.exports={createStore,text};
