'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const runner = require('../lib/workspace-runner');
const planner = require('../lib/code-planner');
const devLoop = require('../lib/dev-loop');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])].map(r=>JSON.parse(JSON.stringify(r)));},get(name,id){const row=stores.get(name)?.get(id);return row?JSON.parse(JSON.stringify(row)):null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,JSON.parse(JSON.stringify(row)));return row;}};}
const MATH='exports.add = (a, b) => a - b;\n';
const MATH_TEST="const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../src/math');\ntest('adds', () => assert.equal(add(2, 3), 5));\n";
function project(extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-loop-'));
  const files={'package.json':JSON.stringify({name:'loop-fixture',private:true,scripts:{test:'node --test'}}),'src/math.js':MATH,'test/math.test.js':MATH_TEST,...extra};
  for(const [rel,content] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),content);}
  execFileSync('git',['init','-q'],{cwd:dir});
  const store=memoryStore(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-loop-data-')),root=scanner.approveRoot(store,{path:dir});
  runner.allowRepository(store,scanner,root.id,['test']);
  store.put('models',{id:'coder:test',name:'coder:test',runtime:'ollama'});
  return {dir:fs.realpathSync(dir),store,dataDir,root};
}
function fakeOllama(replies,prompts){
  return {
    status:async()=>({reachable:true,models:[{name:'coder:test'}]}),
    show:async()=>({capabilities:['completion'],template:'x',details:{},model_info:{'llama.context_length':8192}}),
    chatFull:async(_model,messages,opts)=>{prompts.push(messages[messages.length-1].content);const next=replies.shift();
      if(typeof next==='function')return next(opts);
      return {message:{content:JSON.stringify(next)},done_reason:'stop'};},
  };
}
const plan=(summary,changesList)=>({summary,acceptanceCriteria:[{description:'tests pass'}],changes:changesList});
function deps(p,ollama){return {scanner,changes,runner,planner,ollama,dataDir:p.dataDir};}
const REQUEST='Fix src/math.js so add returns the sum of both numbers';

test('retries with test failures as feedback, then prepares a checked batch without touching the project', async () => {
  const p=project(),prompts=[];
  const ollama=fakeOllama([
    plan('try multiply',[{relativePath:'src/math.js',find:'a - b',replacement:'a * b'}]),
    plan('use addition',[{relativePath:'src/math.js',find:'a * b',replacement:'a + b'}]),
  ],prompts);
  const {loop,done}=devLoop.startLoop(p.store,deps(p,ollama),{rootId:p.root.id,modelId:'coder:test',request:REQUEST,maxAttempts:3});
  assert.equal(loop.status,'running');
  await done;
  const result=p.store.get('workspaceLoops',loop.id);
  assert.equal(result.status,'ready',result.error);
  assert.equal(result.baseline.status,'failed');
  assert.deepEqual(result.attempts.map(a=>a.status),['tests-failed','passed']);
  assert.match(prompts[0],/already fail/,'baseline failure is shared up front');
  assert.match(prompts[1],/Attempt 1 did not pass/);
  assert.match(prompts[1],/6 !== 5|expected|actual/i,'the failing test output is sent back');
  assert.equal(fs.readFileSync(path.join(p.dir,'src/math.js'),'utf8'),MATH,'the project is untouched until approval');
  const batch=p.store.get('workspaceChangeBatches',result.batchId);
  assert.equal(batch.status,'checks-passed');
  assert.deepEqual(batch.changes.map(c=>[c.operation,c.relativePath]),[['overwrite','src/math.js']]);
  changes.approveBatch(p.store,scanner,batch.id);
  changes.executeBatch(p.store,scanner,p.dataDir,batch.id);
  assert.equal(fs.readFileSync(path.join(p.dir,'src/math.js'),'utf8'),'exports.add = (a, b) => a + b;\n');
  assert.equal(spawnSync(process.execPath,['--test'],{cwd:p.dir}).status,0,'the real project now passes its tests');
});

test('an invalid plan becomes feedback, and new files come through as creates', async () => {
  const p=project({'test/greet.test.js':"const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('greets', () => assert.equal(require('../src/greet').greet('Nova'), 'Hello, Nova'));\n",'src/math.js':'exports.add = (a, b) => a + b;\n'}),prompts=[];
  const ollama=fakeOllama([
    plan('bad find',[{relativePath:'src/math.js',find:'not in the file',replacement:'x'}]),
    plan('still bad',[{relativePath:'src/math.js',find:'not in the file',replacement:'x'}]),
    plan('add greet',[{operation:'create',relativePath:'src/greet.js',content:"exports.greet = name => 'Hello, ' + name;\n"}]),
  ],prompts);
  const {loop,done}=devLoop.startLoop(p.store,deps(p,ollama),{rootId:p.root.id,modelId:'coder:test',request:'Create src/greet.js that exports greet returning a greeting'});
  await done;
  const result=p.store.get('workspaceLoops',loop.id);
  assert.equal(result.status,'ready',result.error);
  assert.equal(result.attempts[0].status,'plan-failed');
  assert.match(prompts[1],/Repair|Validation error/,'the planner gets one repair try first');
  assert.match(prompts[2],/plan was rejected: The model plan remained invalid/,'then the failure is fed back as a new attempt');
  assert.deepEqual(p.store.get('workspaceChangeBatches',result.batchId).changes.map(c=>[c.operation,c.relativePath]),[['create','src/greet.js']]);
  assert.ok(!fs.existsSync(path.join(p.dir,'src/greet.js')));
});

test('stops after the attempt cap with no batch', async () => {
  const p=project(),prompts=[];
  const ollama=fakeOllama([
    plan('multiply',[{relativePath:'src/math.js',find:'a - b',replacement:'a * b'}]),
    plan('divide',[{relativePath:'src/math.js',find:'a * b',replacement:'a / b'}]),
  ],prompts);
  const {loop,done}=devLoop.startLoop(p.store,deps(p,ollama),{rootId:p.root.id,modelId:'coder:test',request:REQUEST,maxAttempts:2});
  await done;
  const result=p.store.get('workspaceLoops',loop.id);
  assert.equal(result.status,'attempts-exhausted');
  assert.equal(result.attempts.length,2);
  assert.equal(result.batchId,null);
  assert.equal(p.store.all('workspaceChangeBatches').length,0);
});

test('a file edited in the project during the loop produces a conflict instead of a batch', async () => {
  const p=project(),prompts=[];
  const ollama=fakeOllama([()=>{fs.writeFileSync(path.join(p.dir,'src/math.js'),'// my own edit\n'+MATH);return {message:{content:JSON.stringify(plan('fix',[{relativePath:'src/math.js',find:'a - b',replacement:'a + b'}]))}};}],prompts);
  const {loop,done}=devLoop.startLoop(p.store,deps(p,ollama),{rootId:p.root.id,modelId:'coder:test',request:REQUEST});
  await done;
  const result=p.store.get('workspaceLoops',loop.id);
  assert.equal(result.status,'conflict');
  assert.match(result.error,/src\/math.js/);
  assert.match(fs.readFileSync(path.join(p.dir,'src/math.js'),'utf8'),/my own edit/);
});

test('requires the test allowlist and a specific request, one loop per project', async () => {
  const p=project();
  const d=deps(p,fakeOllama([],[]));
  assert.throws(()=>devLoop.startLoop(p.store,d,{rootId:p.root.id,request:'Improve this.'}),/Clarification required/);
  runner.allowRepository(p.store,scanner,p.root.id,['build']);
  assert.throws(()=>devLoop.startLoop(p.store,d,{rootId:p.root.id,request:REQUEST}),/allowlist the test command/);
  runner.allowRepository(p.store,scanner,p.root.id,['test']);
  const slow=fakeOllama([opts=>new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))))],[]);
  const {loop,done}=devLoop.startLoop(p.store,deps(p,slow),{rootId:p.root.id,modelId:'coder:test',request:REQUEST});
  assert.throws(()=>devLoop.startLoop(p.store,deps(p,slow),{rootId:p.root.id,modelId:'coder:test',request:REQUEST}),/already running/);
  for(let i=0;i<200&&!p.store.get('workspaceLoops',loop.id).phase?.includes('planning');i++)await new Promise(r=>setTimeout(r,25));
  devLoop.cancelLoop(p.store,loop.id);
  await done;
  assert.equal(p.store.get('workspaceLoops',loop.id).status,'cancelled');
  assert.equal(devLoop._active.size,0);
});

test('restart recovery marks running loops interrupted', () => {
  const store=memoryStore();store.put('workspaceLoops',{id:'loop_x',status:'running'});
  assert.equal(devLoop.recoverInterrupted(store),1);
  assert.equal(store.get('workspaceLoops','loop_x').status,'interrupted');
});
