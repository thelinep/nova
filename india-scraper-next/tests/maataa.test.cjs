const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/maataa-store.cjs');
const ai=require('../lib/maataa-ai.cjs');
test('conversation survives reopening; concurrent turn rejected; failed prompt retained; publication preserves source and category',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maataa-test-')),file=path.join(dir,'test.db');
 try{const store=createStore(file);const {id}=await store.create({title:'District research',category:'Research'});
 const first=await store.begin({id,prompt:'Find planners',model:'test-local',mode:'query'});
 await assert.rejects(store.begin({id,prompt:'Concurrent',model:'test-local',mode:'chat'}),/already running/);
 await store.finish(first.id,null,'Ollama offline');
 const reopened=createStore(file);assert.equal((await reopened.detail(id)).messages[0].prompt,'Find planners');assert.equal((await reopened.detail(id)).messages[0].status,'failed');
 await reopened.categorize({id,category:'Query design'});
 const draft=await reopened.draft({id,kind:'milestone',title:'First method reviewed',body:'User review recorded; collection pending.'});
 let snapshot=await reopened.snapshot();assert.equal(snapshot.publications[0].status,'draft');assert.equal(snapshot.publications[0].conversation_id,id);assert.equal(snapshot.publications[0].category,'Query design');
 await reopened.publish(draft);snapshot=await reopened.snapshot();assert.equal(snapshot.publications[0].status,'published');assert.ok(snapshot.publications[0].published_at);await assert.rejects(reopened.publish(draft),/already published/);
 await assert.rejects(store.draft({id:'missing',kind:'update',title:'Bad',body:'Bad'}),/not found/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('query validation rejects unusable and extra placeholders',()=>{assert.deepEqual(ai.validateQuery({name:'Planners',template:'planners in {district}, {state}',rationale:'District scoped'}),{name:'Planners',template:'planners in {district}, {state}',rationale:'District scoped'});for(const template of ['planners','in {district}','{district} {state} {secret}'])assert.throws(()=>ai.validateQuery({name:'Test',template,rationale:'Test'}));});
test('local endpoint refuses remote configuration',()=>{const old=process.env.OLLAMA_BASE_URL;try{process.env.OLLAMA_BASE_URL='https://example.com';assert.throws(()=>ai.localOrigin(),/loopback/);process.env.OLLAMA_BASE_URL='http://127.0.0.1:11434/api/generate';assert.equal(ai.localOrigin(),'http://127.0.0.1:11434')}finally{if(old===undefined)delete process.env.OLLAMA_BASE_URL;else process.env.OLLAMA_BASE_URL=old}});
test('Ollama contract retains context and validates structured output without executing search',async()=>{
 const original=global.fetch;const calls=[];global.fetch=async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});const body=url.endsWith('/api/tags')?{models:[{name:'test-local'}]}:url.endsWith('/api/show')?{capabilities:['completion']}:{message:{content:JSON.stringify({name:'Venues',template:'venues in {district} {state}',rationale:'Find venues'})}};return {ok:true,json:async()=>body}};
 try{const value=await ai.reply('test-local','Find venues',[{status:'complete',prompt:'Outdoor events',response:'Discuss criteria'},{status:'failed',prompt:'Ignore',response:null}],'query');assert.equal(JSON.parse(value).name,'Venues');const chat=calls.find(c=>c.url.endsWith('/api/chat'));assert.equal(chat.body.format,'json');assert.equal(chat.body.messages.length,4);assert.equal(chat.body.messages[1].content,'Outdoor events');assert.equal(calls.length,3)}finally{global.fetch=original}
});
test('cloud-backed installed model is refused before conversation inference',async()=>{const original=global.fetch;let called=false;global.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('/api/tags')?{models:[{name:'remote-alias'}]}:url.endsWith('/api/show')?{remote_host:'https://ollama.com'}:(called=true,{})});try{await assert.rejects(ai.reply('remote-alias','Hello',[],'chat'),/Remote models/);assert.equal(called,false)}finally{global.fetch=original}});
