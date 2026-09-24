'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scanner = require('../lib/workspace-scanner');
const changes = require('../lib/workspace-changes');
const runner = require('../lib/workspace-runner');

function memoryStore(){const stores=new Map();return{all(name){return[...(stores.get(name)?.values()||[])];},get(name,id){const row=stores.get(name)?.get(id);return row?JSON.parse(JSON.stringify(row)):null;},put(name,row){if(!stores.has(name))stores.set(name,new Map());stores.get(name).set(row.id,JSON.parse(JSON.stringify(row)));return row;}};}
function project(pkg,files={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-dev-'));execFileSync('git',['init','-q'],{cwd:dir});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',private:true,...pkg}));
  for(const [rel,content] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),content);}
  const store=memoryStore(),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-dev-data-')),root=scanner.approveRoot(store,{path:dir});
  runner.allowRepository(store,scanner,root.id,['test','build','install','dev']);
  return {dir:fs.realpathSync(dir),store,dataDir,root};
}
async function until(fn,ms=15000){const end=Date.now()+ms;for(;;){const v=fn();if(v)return v;if(Date.now()>end)throw new Error('timed out waiting');await new Promise(r=>setTimeout(r,50));}}

test('install is refused while the workspace is LOCAL ONLY', async () => {
  const p=project({});
  await assert.rejects(()=>runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'install'}),/network access/);
  p.store.put('preferences',{id:'default',webAccess:false});
  await assert.rejects(()=>runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'install'}),/LOCAL ONLY/);
});

test('install runs in the project folder with lifecycle scripts skipped by default', async () => {
  const p=project({scripts:{postinstall:'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"'}});
  p.store.put('preferences',{id:'default',webAccess:true});
  const started=await runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'install'});
  assert.equal(started.status,'running','install returns immediately and runs in the background');
  const done=await until(()=>{const r=p.store.get('workspaceRuns',started.id);return r.status!=='running'&&r;},60000);
  assert.equal(done.status,'passed',done.output);
  assert.deepEqual(done.command.args,['install','--no-audit','--no-fund','--ignore-scripts']);
  assert.equal(done.command.cwd,p.root.path);
  assert.ok(fs.existsSync(path.join(p.dir,'package-lock.json')),'lockfile written in the real folder');
  assert.ok(!fs.existsSync(path.join(p.dir,'ran.txt')),'postinstall did not run');
  const again=runner.commandFor('install',p.dir,{allowScripts:true});
  assert.deepEqual(again.args,['ci','--no-audit','--no-fund'],'a lockfile switches to npm ci; opting in keeps scripts');
});

test('tests in the workspace copy resolve the project\'s installed packages', async () => {
  const p=project({scripts:{test:'node check.js'}},{'check.js':'console.log(require("local-dep"))\n','node_modules/local-dep/index.js':'module.exports = "dep ok";\n'});
  const result=await runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'test'});
  assert.equal(result.status,'passed',result.output);
  assert.match(result.output,/dep ok/);
  assert.equal(result.workspaceCopy.linkedDependencies,true);
});

test('a dev server runs in the project folder, reports its address, streams logs, and stops', async () => {
  const server=`const http=require('http');const s=http.createServer((q,r)=>r.end('hello from dev'));s.listen(Number(process.env.PORT)||0,process.env.HOST,()=>{console.log('ready on http://'+process.env.HOST+':'+s.address().port);setInterval(()=>console.log('tick'),100);});`;
  const p=project({scripts:{dev:'node server.js'}},{'server.js':server});
  const started=await runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'dev'});
  assert.equal(started.status,'running');
  const withUrl=await until(()=>{const r=p.store.get('workspaceRuns',started.id);return r.url&&r;});
  assert.match(withUrl.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await (await fetch(withUrl.url)).text(),'hello from dev');
  await assert.rejects(()=>runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'dev'}),/already running/);
  p.store.put('preferences',{id:'default',webAccess:true});
  await assert.rejects(()=>runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'install'}),/Stop the dev server/);
  const first=runner.getRun(p.store,started.id,0);
  const later=await until(()=>{const r=runner.getRun(p.store,started.id,first.outputTotal);return r.output.includes('tick')&&r;});
  assert.ok(later.outputFrom>=first.outputTotal,'polling returns only new output');
  runner.cancel(p.store,started.id);
  const stopped=await until(()=>{const r=p.store.get('workspaceRuns',started.id);return r.status!=='running'&&r;});
  assert.equal(stopped.status,'stopped');
  assert.equal(runner._devServers.has(p.root.id),false);
  await assert.rejects(()=>fetch(withUrl.url),'the server process is gone');
});

test('dev requires a dev or start script', async () => {
  const p=project({scripts:{test:'node -e 0'}});
  await assert.rejects(()=>runner.run(p.store,scanner,changes,p.dataDir,{rootId:p.root.id,action:'dev'}),/No dev or start script/);
  assert.equal(runner._devServers.has(p.root.id),false);
  assert.equal(p.store.all('workspaceRuns').length,0,'nothing is recorded for a command that cannot start');
});

test('allowlist gates install and dev like every other action', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-dev-gate-'));execFileSync('git',['init','-q'],{cwd:dir});fs.writeFileSync(path.join(dir,'package.json'),'{"scripts":{"dev":"node -e 0"}}');
  const store=memoryStore(),root=scanner.approveRoot(store,{path:dir});runner.allowRepository(store,scanner,root.id,['test']);
  await assert.rejects(()=>runner.run(store,scanner,changes,dir,{rootId:root.id,action:'dev'}),/not allowlisted/);
  assert.throws(()=>runner.commandFor('dev',fs.mkdtempSync(path.join(os.tmpdir(),'nova-nopkg-'))),/No supported/);
});
